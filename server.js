
import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Limitation des tentatives propriétaire
const ownerAttempts = new Map();

function createOwnerToken() {
  const payload = Buffer.from(JSON.stringify({
    role: "owner",
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", OWNER_TOKEN_SECRET)
    .update(payload)
    .digest("base64url");

  return payload + "." + signature;
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
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    );

    return data.role === "owner" && data.exp > Date.now();
  } catch {
    return false;
  }
}

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  return authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
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

// Clé API
function getToken() {
  return (
    process.env.FOOTBALL_DATA_API_KEY ||
    process.env.FOOTBALL_DATA_API_TOKEN ||
    process.env.FOOTBALL_DATA_TOKEN ||
    ""
  ).trim();
}

// Date Burkina Faso
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function daysBetween(from, to) {
  return Math.round(
    (new Date(`${to}T00:00:00Z`) -
      new Date(`${from}T00:00:00Z`)) / 86400000
  );
}

function validatePeriod(from, to) {
  if (!validDate(from) || !validDate(to)) {
    return "Dates invalides. Format attendu : YYYY-MM-DD.";
  }

  if (from > to) {
    return "La date de début doit précéder la date de fin.";
  }

  if (daysBetween(from, to) > MAX_PERIOD_DAYS) {
    return "La période ne doit pas dépasser 10 jours.";
  }

  return null;
}

function sortMatches(matches) {
  return matches.sort(
    (a, b) => new Date(a.utcDate) - new Date(b.utcDate)
  );
}

function apiErrorMessage(data, fallback) {
  return data?.message || data?.error || fallback;
}

// Connexion football-data.org
async function footballRequest(endpoint, query = {}) {
  const token = getToken();

  if (!token) {
    const error = new Error(
      "Clé API football-data.org non configurée sur Render."
    );
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
      const error = new Error(
        apiErrorMessage(data, "Erreur football-data.org.")
      );
      error.status = response.status;
      error.details = data;
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

    const e = new Error(
      "Impossible de contacter football-data.org."
    );
    e.status = 502;
    throw e;

  } finally {
    clearTimeout(timeout);
  }
}

function sendError(res, error) {
  console.error("API error:", error);

  return res.status(error.status || 500).json({
    status: "ERROR",
    message: error.message || "Erreur interne du serveur.",
    apiStatus: error.status || 500
  });
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

// Récupération des matchs par périodes de 10 jours
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

    if (Array.isArray(data.matches)) {
      matches.push(...data.matches);
    }

    cursor = addDays(end, 1);
  }

  const unique = [
    ...new Map(matches.map(m => [m.id, m])).values()
  ];

  return sortMatches(unique);
}

// Calcul des statistiques à partir des scores officiels
function calculateTeamStats(teamId, matches) {
  let played = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let cleanSheets = 0;
  let failedToScore = 0;

  for (const match of matches) {
    const homeId = Number(match.homeTeam?.id);
    const awayId = Number(match.awayTeam?.id);

    const homeScore = match.score?.fullTime?.home;
    const awayScore = match.score?.fullTime?.away;

    if (!Number.isInteger(homeScore) ||
        !Number.isInteger(awayScore)) continue;

    let scored;
    let conceded;

    if (homeId === Number(teamId)) {
      scored = homeScore;
      conceded = awayScore;
    } else if (awayId === Number(teamId)) {
      scored = awayScore;
      conceded = homeScore;
    } else {
      continue;
    }

    played++;
    goalsFor += scored;
    goalsAgainst += conceded;

    if (scored > conceded) wins++;
    else if (scored === conceded) draws++;
    else losses++;

    if (conceded === 0) cleanSheets++;
    if (scored === 0) failedToScore++;
  }

  return {
    played,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    goalsForAverage: played
      ? Number((goalsFor / played).toFixed(2)) : null,
    goalsAgainstAverage: played
      ? Number((goalsAgainst / played).toFixed(2)) : null,
    cleanSheets,
    failedToScore,
    dataSource: "Scores officiels football-data.org"
  };
}

// Accès propriétaire
app.post("/api/owner/access", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  const attempts = ownerAttempts.get(ip) || {
    count: 0,
    start: now,
    blockedUntil: 0
  };

  if (attempts.blockedUntil > now) {
    return res.status(429).json({
      status: "ERROR",
      message: "Trop de tentatives. Réessaie plus tard."
    });
  }

  if (now - attempts.start > 15 * 60 * 1000) {
    attempts.count = 0;
    attempts.start = now;
    attempts.blockedUntil = 0;
  }

  if (!OWNER_ACCESS_CODE || !OWNER_TOKEN_SECRET) {
    return res.status(503).json({
      status: "ERROR",
      message: "Accès propriétaire non configuré sur Render."
    });
  }

  const code = String(req.body?.code || "");
  const supplied = Buffer.from(code);
  const expected = Buffer.from(OWNER_ACCESS_CODE);

  const valid = supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected);

  if (!valid) {
    attempts.count++;

    if (attempts.count >= 5) {
      attempts.blockedUntil = now + 15 * 60 * 1000;
    }

    ownerAttempts.set(ip, attempts);

    return res.status(401).json({
      status: "ERROR",
      message: "Code propriétaire incorrect."
    });
  }

  ownerAttempts.delete(ip);

  return res.json({
    status: "OK",
    role: "owner",
    token: createOwnerToken(),
    vip: true,
    analysis: true,
    message: "Accès propriétaire activé."
  });
});

// Vérification propriétaire
app.get("/api/owner/verify", requireOwner, (req, res) => {
  return res.json({
    status: "OK",
    role: "owner",
    vip: true,
    analysis: true
  });
});

// Santé serveur
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    message: "Serveur actif",
    time: new Date().toISOString()
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    footballDataConfigured: Boolean(getToken()),
    ownerAccessConfigured: Boolean(
      OWNER_ACCESS_CODE && OWNER_TOKEN_SECRET
    ),
    footballDataSource: "football-data.org API V4",
    dateBurkina: getBurkinaDate(),
    maximumPeriodDays: MAX_PERIOD_DAYS,
    historyRequired: HISTORY_REQUIRED,
    historyTarget: HISTORY_TARGET
  });
});

// Matchs du jour
app.get("/api/matches", async (req, res) => {
  const today = getBurkinaDate();
  const dateFrom = req.query.dateFrom || today;
  const dateTo = req.query.dateTo || today;
  const error = validatePeriod(dateFrom, dateTo);

  if (error) {
    return res.status(400).json({
      status: "ERROR",
      message: error
    });
  }

  return sendFootball(res, "/matches", {
    ...req.query,
    dateFrom,
    dateTo
  });
});

// Matchs à venir
app.get("/api/matches/upcoming", async (req, res) => {
  const today = getBurkinaDate();
  const dateFrom = req.query.dateFrom || today;
  const dateTo = req.query.dateTo || addDays(today, 9);
  const error = validatePeriod(dateFrom, dateTo);

  if (error) {
    return res.status(400).json({
      status: "ERROR",
      message: error
    });
  }

  return sendFootball(res, "/matches", {
    ...req.query,
    dateFrom,
    dateTo
  });
});

// Historique global des matchs terminés
app.get("/api/matches/history", async (req, res) => {
  try {
    const today = getBurkinaDate();
    const dateFrom = req.query.dateFrom || addDays(today, -30);
    const dateTo = req.query.dateTo || today;

    const error = validatePeriod(dateFrom, dateTo);
    if (error) {
      return res.status(400).json({
        status: "ERROR",
        message: error
      });
    }

    const matches = await fetchMatchesInPeriod(
      "/matches",
      dateFrom,
      dateTo,
      { status: "FINISHED" }
    );

    const finished = matches.filter(
      m => m.status === "FINISHED"
    );

    return res.json({
      status: "OK",
      source: "football-data.org API V4",
      application: "DRABO73 VIP PRONOS",
      total: finished.length,
      dateFrom,
      dateTo,
      matches: finished
    });

  } catch (error) {
    return sendError(res, error);
  }
});

// Période personnalisée
app.get("/api/matches/period", async (req, res) => {
  const dateFrom = req.query.dateFrom;
  const dateTo = req.query.dateTo;
  const error = validatePeriod(dateFrom, dateTo);

  if (error) {
    return res.status(400).json({
      status: "ERROR",
      message: error
    });
  }

  return sendFootball(res, "/matches", {
    ...req.query,
    dateFrom,
    dateTo
  });
});

// CINQ derniers matchs terminés d'une équipe
app.get("/api/teams/:id/recent-matches", async (req, res) => {
  const teamId = String(req.params.id);

  if (!/^\d+$/.test(teamId)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant équipe invalide."
    });
  }

  try {
    const today = getBurkinaDate();
    const oldestDate = addDays(today, -HISTORY_MAX_DAYS);
    const allMatches = new Map();

    let periodEnd = today;

    // Recherche progressive jusqu'à 5 matchs ou 365 jours
    while (
      periodEnd >= oldestDate &&
      allMatches.size < HISTORY_TARGET
    ) {
      let periodStart = addDays(periodEnd, -9);

      if (periodStart < oldestDate) {
        periodStart = oldestDate;
      }

      const data = await footballRequest(
        `/teams/${teamId}/matches`,
        {
          status: "FINISHED",
          dateFrom: periodStart,
          dateTo: periodEnd,
          limit: 100
        }
      );

      for (const match of (data.matches || [])) {
        if (match.id) {
          allMatches.set(match.id, match);
        }
      }

      periodEnd = addDays(periodStart, -1);
    }

    const matches = [...allMatches.values()]
      .filter(match => {
        const homeId = Number(match.homeTeam?.id);
        const awayId = Number(match.awayTeam?.id);

        const belongs =
          homeId === Number(teamId) ||
          awayId === Number(teamId);

        const homeScore = match.score?.fullTime?.home;
        const awayScore = match.score?.fullTime?.away;

        return match.status === "FINISHED" &&
          belongs &&
          Number.isInteger(homeScore) &&
          Number.isInteger(awayScore);
      })
      .sort((a, b) =>
        new Date(b.utcDate) - new Date(a.utcDate)
      )
      .slice(0, HISTORY_TARGET);

    const statistics = calculateTeamStats(teamId, matches);
    const sufficient = matches.length >= HISTORY_REQUIRED;

    return res.json({
      status: "OK",
      source: "football-data.org API V4",
      application: "DRABO73 VIP PRONOS",
      teamId: Number(teamId),
      total: matches.length,
      minimumRequired: HISTORY_REQUIRED,
      target: HISTORY_TARGET,
      sufficient,
      statistics,
      message: sufficient
        ? "Historique récupéré. Analyse statistique possible."
        : `Historique insuffisant : ${matches.length} match(s) terminé(s) avec score disponible.`,
      matches
    });

  } catch (error) {
    return sendError(res, error);
  }
});

// Détails d'un match
app.get("/api/matches/:id", async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant de match invalide."
    });
  }

  return sendFootball(res, `/matches/${req.params.id}`);
});

// Confrontations directes
app.get("/api/matches/:id/head2head", async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant de match invalide."
    });
  }

  return sendFootball(
    res,
    `/matches/${req.params.id}/head2head`,
    req.query
  );
});

// Compétitions
app.get("/api/competitions", async (req, res) => {
  return sendFootball(res, "/competitions", req.query);
});

// Matchs d'une compétition
app.get("/api/competitions/:id/matches", async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant de compétition invalide."
    });
  }

  const query = { ...req.query };

  if (query.dateFrom || query.dateTo) {
    const error = validatePeriod(query.dateFrom, query.dateTo);

    if (error) {
      return res.status(400).json({
        status: "ERROR",
        message: error
      });
    }
  }

  return sendFootball(
    res,
    `/competitions/${req.params.id}/matches`,
    query
  );
});

// Classement
app.get("/api/competitions/:id/standings", async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant de compétition invalide."
    });
  }

  return sendFootball(
    res,
    `/competitions/${req.params.id}/standings`,
    req.query
  );
});

// Fichiers de l'application
const publicPath = path.join(__dirname, "public");
const distPath = path.join(__dirname, "dist");

if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
}

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// Accueil
app.get("/", (req, res) => {
  const distIndex = path.join(distPath, "index.html");
  const publicIndex = path.join(publicPath, "index.html");

  if (fs.existsSync(distIndex)) {
    return res.sendFile(distIndex);
  }

  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }

  return res.json({
    application: "DRABO73 VIP PRONOS",
    slogan: "LA CONFIANCE RESTE",
    status: "Serveur actif",
    footballDataConfigured: Boolean(getToken())
  });
});

// Route inconnue
app.use((req, res) => {
  res.status(404).json({
    status: "ERROR",
    message: "Route introuvable.",
    path: req.originalUrl
  });
});

// Erreurs générales
app.use((error, req, res, next) => {
  console.error("Server error:", error);

  if (res.headersSent) return next(error);

  res.status(500).json({
    status: "ERROR",
    message: "Erreur interne du serveur."
  });
});

// Démarrage
app.listen(PORT, "0.0.0.0", () => {
  console.log("------------------------------------");
  console.log("DRABO73 VIP PRONOS");
  console.log("LA CONFIANCE RESTE");
  console.log(`Serveur actif sur le port ${PORT}`);
  console.log(
    `Football-data API : ${getToken() ? "CONFIGURÉE" : "NON CONFIGURÉE"}`
  );
  console.log(
    `Accès propriétaire : ${
      OWNER_ACCESS_CODE && OWNER_TOKEN_SECRET
        ? "CONFIGURÉ" : "NON CONFIGURÉ"
    }`
  );
  console.log("------------------------------------");
});
