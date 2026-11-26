
import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const API_BASE = "https://api.football-data.org/v4";
const TIMEZONE = "Africa/Ouagadougou";

const MAX_PERIOD_DAYS = 10;
const HISTORY_REQUIRED = 3;
const HISTORY_TARGET = 5;
const HISTORY_MAX_DAYS = 365;

const OWNER_ACCESS_CODE = process.env.OWNER_ACCESS_CODE || "";
const OWNER_TOKEN_SECRET = process.env.OWNER_TOKEN_SECRET || "";

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// PROTECTION PROPRIETAIRE
const ownerAttempts = new Map();

function createOwnerToken() {
  const payload = Buffer.from(JSON.stringify({
    role: "owner",
    exp: Date.now() + 30 * 86400000
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", OWNER_TOKEN_SECRET)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function verifyOwnerToken(token) {
  if (!token || !OWNER_TOKEN_SECRET) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [payload, signature] = parts;

  const expected = crypto
    .createHmac("sha256", OWNER_TOKEN_SECRET)
    .update(payload)
    .digest("base64url");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return false;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.role === "owner" && Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function requireOwner(req, res, next) {
  if (!verifyOwnerToken(getBearerToken(req))) {
    return res.status(401).json({
      status: "ERROR",
      message: "Accès propriétaire non valide."
    });
  }
  next();
}

// CLE API FOOTBALL
function getToken() {
  return (
    process.env.FOOTBALL_DATA_API_KEY ||
    process.env.FOOTBALL_DATA_API_TOKEN ||
    process.env.FOOTBALL_DATA_TOKEN ||
    ""
  ).trim();
}

// DATE BURKINA FASO
function getBurkinaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateString, amount) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function daysBetween(from, to) {
  return Math.round(
    (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000
  );
}

function validatePeriod(from, to, maximum = MAX_PERIOD_DAYS) {
  if (!validDate(from) || !validDate(to)) {
    return "Dates invalides. Format attendu : YYYY-MM-DD.";
  }
  if (from > to) return "La date de début doit précéder la date de fin.";
  if (daysBetween(from, to) > maximum) {
    return `La période ne doit pas dépasser ${maximum} jours.`;
  }
  return null;
}

function sortMatches(matches) {
  return matches.sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
}

function sendError(res, error) {
  console.error("API error:", error);
  const status = Number(error?.status || error?.statusCode) || 500;
  return res.status(status).json({
    status: "ERROR",
    message: error?.message || "Erreur interne du serveur.",
    apiStatus: status
  });
}

// CONNEXION FOOTBALL-DATA.ORG
async function footballRequest(endpoint, query = {}) {
  const token = getToken();

  if (!token) {
    const error = new Error("Clé API football-data.org non configurée sur Render.");
    error.status = 503;
    throw error;
  }

  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-Auth-Token": token,
        "Accept": "application/json"
      },
      signal: controller.signal
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { message: "Réponse API illisible." };
    }

    if (!response.ok) {
      const error = new Error(data.message || data.error || "Erreur football-data.org.");
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const e = new Error("Délai de connexion dépassé.");
      e.status = 504;
      throw e;
    }
    if (error.status) throw error;
    const e = new Error("Impossible de contacter football-data.org.");
    e.status = 502;
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendFootball(res, endpoint, query = {}) {
  try {
    const data = await footballRequest(endpoint, query);
    return res.json({
      status: "OK",
      source: "football-data.org API V4",
      ...data
    });
  } catch (error) {
    return sendError(res, error);
  }
}

// RECHERCHE PAR PERIODES
async function fetchMatchesInPeriod(endpoint, from, to, extra = {}) {
  const matches = [];
  let cursor = from;

  while (cursor <= to) {
    const chunkEnd = addDays(cursor, 9);
    const end = chunkEnd > to ? to : chunkEnd;
    const data = await footballRequest(endpoint, {
      ...extra,
      dateFrom: cursor,
      dateTo: end
    });
    if (Array.isArray(data.matches)) matches.push(...data.matches);
    cursor = addDays(end, 1);
  }

  const unique = [...new Map(matches.map(match => [match.id, match])).values()];
  return sortMatches(unique);
}
