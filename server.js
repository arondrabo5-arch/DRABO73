
import express from "express";
import path from "path";
import fs from "fs";
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

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// Clé API
function getToken() {
  return (
    process.env.FOOTBALL_DATA_API_KEY ||
    process.env.FOOTBALL_DATA_API_TOKEN ||
    process.env.FOOTBALL_DATA_TOKEN ||
    ""
  ).trim();
}

// Date du Burkina Faso
function getBurkinaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
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

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
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

  // Maximum 10 jours calendaires inclus
  if (daysBetween(from, to) >= MAX_PERIOD_DAYS) {
    return "La période ne doit pas dépasser 10 jours.";
  }

  return null;
}

function apiErrorMessage(data, fallback) {
  return data?.message || data?.error || fallback;
}

function sortMatches(matches) {
  return matches.sort(
    (a, b) => new Date(a.utcDate) - new Date(b.utcDate)
  );
}

// Appel sécurisé de football-data.org
async function footballRequest(endpoint, query = {}) {
  const token = getToken();

  if (!token) {
    const error = new Error(
      "Clé API football-data.org non configurée."
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
      const timeoutError = new Error(
        "Délai dépassé lors de la connexion à football-data.org."
      );
      timeoutError.status = 504;
      throw timeoutError;
    }

    if (error.status) throw error;

    const networkError = new Error(
      "Impossible de contacter football-data.org."
    );

    networkError.status = 502;
    throw networkError;

  } finally {
    clearTimeout(timeout);
  }
}

// Réponse API uniforme
function sendError(res, error) {
  console.error("API error:", error);

  return res.status(error.status || 500).json({
    status: "ERROR",
    message: error.message || "Erreur interne du serveur.",
    apiStatus: error.status || 500,
    details: error.details || undefined
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

// Récupération d'une période par blocs de 10 jours maximum
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

  // Supprimer les doublons
  const unique = [
    ...new Map(matches.map(match => [match.id, match])).values()
  ];

  return sortMatches(unique);
}

// État du serveur
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
    footballDataSource: "football-data.org API V4",
    dateBurkina: getBurkinaDate(),
    maximumPeriodDays: MAX_PERIOD_DAYS
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

// Matchs à venir : 10 jours maximum
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

// Historique des matchs terminés : 30 derniers jours
app.get("/api/matches/history", async (req, res) => {
  try {
    const today = getBurkinaDate();
    const dateFrom = req.query.dateFrom || addDays(today, -30);
    const dateTo = req.query.dateTo || today;

    if (req.query.dateFrom || req.query.dateTo) {
      const error = validatePeriod(dateFrom, dateTo);

      if (error) {
        return res.status(400).json({
          status: "ERROR",
          message: error
        });
      }
    }

    const matches = await fetchMatchesInPeriod(
      "/matches",
      dateFrom,
      dateTo,
      { status: "FINISHED" }
    );

    const finished = matches.filter(
      match => match.status === "FINISHED"
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

// Période personnalisée, maximum 10 jours
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

// Trois derniers matchs terminés d'une équipe
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
    const allMatches = [];

    // Recherche par périodes successives de 10 jours.
    // Arrêt dès que trois résultats réels sont trouvés.
    let periodEnd = today;
    const oldestDate = addDays(today, -90);

    while (periodEnd >= oldestDate && allMatches.length < 3) {
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

      if (Array.isArray(data.matches)) {
        allMatches.push(...data.matches);
      }

      periodEnd = addDays(periodStart, -1);
    }

    const unique = [
      ...new Map(allMatches.map(match => [match.id, match])).values()
    ];

    const matches = unique
      .filter(match => {
        const homeId = Number(match.homeTeam?.id);
        const awayId = Number(match.awayTeam?.id);

        const belongsToTeam =
          homeId === Number(teamId) ||
          awayId === Number(teamId);

        const homeScore = match.score?.fullTime?.home;
        const awayScore = match.score?.fullTime?.away;

        return (
          match.status === "FINISHED" &&
          belongsToTeam &&
          Number.isInteger(homeScore) &&
          Number.isInteger(awayScore)
        );
      })
      .sort(
        (a, b) => new Date(b.utcDate) - new Date(a.utcDate)
      )
      .slice(0, 3);

    return res.json({
      status: "OK",
      source: "football-data.org API V4",
      application: "DRABO73 VIP PRONOS",
      teamId: Number(teamId),
      total: matches.length,
      sufficient: matches.length === 3,
      message: matches.length === 3
        ? "Les trois derniers matchs terminés ont été récupérés."
        : `Seulement ${matches.length} match(s) avec score disponible sur les 90 derniers jours.`,
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
    const error = validatePeriod(
      query.dateFrom,
      query.dateTo
    );

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

// Classement d'une compétition
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

// Page d'accueil
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

  if (res.headersSent) {
    return next(error);
  }

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
  console.log("------------------------------------");
});
