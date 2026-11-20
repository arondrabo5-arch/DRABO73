
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

// Clé API football-data.org
function getToken() {
  return (
    process.env.FOOTBALL_DATA_API_KEY ||
    process.env.FOOTBALL_DATA_API_TOKEN ||
    process.env.FOOTBALL_DATA_TOKEN ||
    ""
  ).trim();
}

// Date locale Burkina Faso
function getBurkinaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Ouagadougou",
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

function apiErrorMessage(data, fallback) {
  return data?.message || data?.error || fallback;
}

// Appel sécurisé de football-data.org
async function footballRequest(endpoint, req, res, options = {}) {
  const token = getToken();

  if (!token) {
    return res.status(503).json({
      status: "ERROR",
      message: "Clé API football-data.org non configurée.",
      requiredEnvironmentVariable: "FOOTBALL_DATA_API_KEY"
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const url = new URL(`${API_BASE}${endpoint}`);

    const query = { ...req.query };

    if (options.defaultToday) {
      query.dateFrom = getBurkinaDate();
      query.dateTo = getBurkinaDate();
    }

    if (options.defaultUpcoming) {
      query.dateFrom = getBurkinaDate();
      query.dateTo = addDays(getBurkinaDate(), 30);
    }

    if (options.defaultHistory) {
      query.dateFrom = addDays(getBurkinaDate(), -30);
      query.dateTo = getBurkinaDate();
      query.status = "FINISHED";
    }

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

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
      data = { message: raw || "Réponse API illisible." };
    }

    if (!response.ok) {
      console.error("Football-data API error:", response.status, data);

      return res.status(response.status).json({
        status: "ERROR",
        message: apiErrorMessage(data, "Erreur football-data.org."),
        apiStatus: response.status,
        details: data
      });
    }

    return res.json({
      status: "OK",
      source: "football-data.org API V4",
      ...data
    });

  } catch (error) {
    console.error("Football request error:", error);

    return res.status(502).json({
      status: "ERROR",
      message: error.name === "AbortError"
        ? "Délai dépassé lors de la connexion à football-data.org."
        : "Impossible de contacter football-data.org.",
      details: error.message
    });

  } finally {
    clearTimeout(timeout);
  }
}

// Accueil / état du serveur
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
    dateBurkina: getBurkinaDate()
  });
});

// Matchs du jour
app.get("/api/matches", async (req, res) => {
  const hasDates = req.query.dateFrom || req.query.dateTo;

  if (hasDates) {
    return footballRequest("/matches", req, res);
  }

  return footballRequest("/matches", req, res, {
    defaultToday: true
  });
});

// Matchs à venir
app.get("/api/matches/upcoming", async (req, res) => {
  return footballRequest("/matches", req, res, {
    defaultUpcoming: true
  });
});

// Historique général des matchs terminés
app.get("/api/matches/history", async (req, res) => {
  return footballRequest("/matches", req, res, {
    defaultHistory: true
  });
});

// Matchs sur une période personnalisée
app.get("/api/matches/period", async (req, res) => {
  const dateFrom = req.query.dateFrom;
  const dateTo = req.query.dateTo;

  if (!validDate(dateFrom) || !validDate(dateTo)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Dates invalides. Format attendu : YYYY-MM-DD."
    });
  }

  if (dateFrom > dateTo) {
    return res.status(400).json({
      status: "ERROR",
      message: "La date de début doit précéder la date de fin."
    });
  }

  if (daysBetween(dateFrom, dateTo) > 10) {
    return res.status(400).json({
      status: "ERROR",
      message: "La période ne doit pas dépasser 10 jours."
    });
  }

  return footballRequest("/matches", req, res);
});

// 3 derniers matchs terminés d'une équipe
app.get("/api/teams/:id/recent-matches", async (req, res) => {
  const teamId = String(req.params.id);

  if (!/^\d+$/.test(teamId)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant équipe invalide."
    });
  }

  const token = getToken();

  if (!token) {
    return res.status(503).json({
      status: "ERROR",
      message: "Clé API non configurée."
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const today = getBurkinaDate();
    const dateFrom = addDays(today, -365);
    const allMatches = [];

    // Pagination pour récupérer les résultats disponibles
    let offset = 0;
    const limit = 100;
    let total = Infinity;

    while (offset < total && offset < 500) {
      const url = new URL(
        `${API_BASE}/teams/${teamId}/matches`
      );

      url.searchParams.set("status", "FINISHED");
      url.searchParams.set("dateFrom", dateFrom);
      url.searchParams.set("dateTo", today);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));

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
        data = { message: raw };
      }

      if (!response.ok) {
        return res.status(response.status).json({
          status: "ERROR",
          message: apiErrorMessage(
            data,
            "Erreur lors de la récupération de l'historique."
          ),
          apiStatus: response.status,
          teamId: Number(teamId),
          details: data
        });
      }

      const batch = Array.isArray(data.matches) ? data.matches : [];
      total = Number(data.resultSet?.count ?? batch.length);

      allMatches.push(...batch);

      if (batch.length === 0 || batch.length < limit) break;
      offset += batch.length;
    }

    const matches = allMatches
      .filter(match => {
        const homeId = Number(match.homeTeam?.id);
        const awayId = Number(match.awayTeam?.id);

        const belongsToTeam =
          homeId === Number(teamId) ||
          awayId === Number(teamId);

        const homeScore = match.score?.fullTime?.home;
        const awayScore = match.score?.fullTime?.away;

        const hasRealScore =
          Number.isInteger(homeScore) &&
          Number.isInteger(awayScore);

        return (
          match.status === "FINISHED" &&
          belongsToTeam &&
          hasRealScore
        );
      })
      .sort((a, b) =>
        new Date(b.utcDate).getTime() -
        new Date(a.utcDate).getTime()
      )
      .filter((match, index, array) =>
        array.findIndex(item => item.id === match.id) === index
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
        ? "Les 3 derniers matchs terminés ont été récupérés."
        : `Seulement ${matches.length} match(s) terminé(s) disponible(s) dans les données accessibles.`,
      matches
    });

  } catch (error) {
    console.error("Recent matches error:", error);

    return res.status(502).json({
      status: "ERROR",
      message: error.name === "AbortError"
        ? "Délai dépassé pendant la récupération de l'historique."
        : "Impossible de récupérer les derniers matchs.",
      details: error.message
    });

  } finally {
    clearTimeout(timeout);
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

  return footballRequest(`/matches/${req.params.id}`, req, res);
});

// Confrontations directes
app.get("/api/matches/:id/head2head", async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant de match invalide."
    });
  }

  return footballRequest(
    `/matches/${req.params.id}/head2head`,
    req,
    res
  );
});

// Liste des compétitions
app.get("/api/competitions", async (req, res) => {
  return footballRequest("/competitions", req, res);
});

// Matchs d'une compétition
app.get("/api/competitions/:id/matches", async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant de compétition invalide."
    });
  }

  return footballRequest(
    `/competitions/${req.params.id}/matches`,
    req,
    res
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

  return footballRequest(
    `/competitions/${req.params.id}/standings`,
    req,
    res
  );
});

// Fichiers statiques de l'application
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
    status: "Serveur actif"
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

// Erreurs serveur
app.use((error, req, res, next) => {
  console.error("Server error:", error);

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
  console.log(`Football-data API : ${Boolean(getToken()) ? "CONFIGURÉE" : "NON CONFIGURÉE"}`);
  console.log("------------------------------------");
});
