
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const API = "https://api.football-data.org/v4";

const CACHE_DURATION = 5 * 60 * 1000;
let cache = {};
 
// DATE DU BURKINA FASO
function getBurkinaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Ouagadougou",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};
  parts.forEach(p => values[p.type] = p.value);

  return `${values.year}-${values.month}-${values.day}`;
}

// AJOUTER DES JOURS
function addDays(date, days) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// VALIDATION DATE
function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;

  const d = new Date(date + "T00:00:00Z");

  return !isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === date;
}

// PAGE PRINCIPALE
app.get("/", (req, res) => {
  res.json({
    application: "DRABO73 VIP PRONOS",
    slogan: "La confiance reste",
    message: "Bienvenue sur DRABO73",
    status: "Serveur actif"
  });
});

// STATUT SERVEUR ET API
app.get("/api/status", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    football_api_configured: Boolean(API_KEY),
    api_connection: API_KEY ? "CONFIGURED" : "NOT_CONFIGURED",
    date: getBurkinaDate()
  });
});

// FONCTION DE CONNEXION FOOTBALL DATA
async function footballRequest(endpoint) {
  if (!API_KEY) {
    throw new Error("Aucun jeton API configuré");
  }

  const response = await fetch(`${API}${endpoint}`, {
    method: "GET",
    headers: {
      "X-Auth-Token": API_KEY,
      "Accept": "application/json"
    }
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data.message || "Erreur football-data.org"
    );
    error.status = response.status;
    throw error;
  }

  return data;
}

// MATCHS DU JOUR ET DES PROCHAINS JOURS
app.get("/api/matches", async (req, res) => {
  try {
    const today = getBurkinaDate();

    const dateFrom = req.query.dateFrom || today;
    const dateTo = req.query.dateTo || addDays(today, 6);

    if (!validDate(dateFrom) || !validDate(dateTo)) {
      return res.status(400).json({
        status: "ERROR",
        message: "Format de date invalide. Utilisez YYYY-MM-DD."
      });
    }

    const start = new Date(dateFrom + "T00:00:00Z");
    const end = new Date(dateTo + "T00:00:00Z");

    const difference = (end - start) / 86400000;

    if (difference < 0 || difference > 9) {
      return res.status(400).json({
        status: "ERROR",
        message: "La période doit être comprise entre 1 et 10 jours."
      });
    }

    const cacheKey = `${dateFrom}_${dateTo}`;

    if (
      cache[cacheKey] &&
      Date.now() - cache[cacheKey].time < CACHE_DURATION
    ) {
      return res.json(cache[cacheKey].data);
    }

    const result = await footballRequest(
      `/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`
    );

    const matches = (result.matches || []).map(match => ({
      id: match.id,
      utcDate: match.utcDate,
      status: match.status,
      matchday: match.matchday,

      area: {
        id: match.area?.id,
        name: match.area?.name,
        code: match.area?.code,
        flag: match.area?.flag
      },

      competition: {
        id: match.competition?.id,
        name: match.competition?.name,
        code: match.competition?.code,
        type: match.competition?.type,
        emblem: match.competition?.emblem
      },

      homeTeam: {
        id: match.homeTeam?.id,
        name: match.homeTeam?.name,
        shortName: match.homeTeam?.shortName,
        crest: match.homeTeam?.crest
      },

      awayTeam: {
        id: match.awayTeam?.id,
        name: match.awayTeam?.name,
        shortName: match.awayTeam?.shortName,
        crest: match.awayTeam?.crest
      },

      score: match.score,
      referees: match.referees || []
    }));

    const responseData = {
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      dateFrom,
      dateTo,
      competition: "Toutes les compétitions accessibles",
      totalMatches: matches.length,
      message: matches.length
        ? "Rencontres réelles récupérées"
        : "Aucune rencontre disponible pour cette période",
      matches
    };

    cache[cacheKey] = {
      time: Date.now(),
      data: responseData
    };

    res.json(responseData);

  } catch (error) {
    console.error("ERREUR MATCHS:", error.message);

    res.status(error.status || 500).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// LISTE DES COMPÉTITIONS ACCESSIBLES
app.get("/api/competitions", async (req, res) => {
  try {
    const result = await footballRequest("/competitions");

    res.json({
      status: "OK",
      totalCompetitions: (result.competitions || []).length,
      competitions: result.competitions || []
    });

  } catch (error) {
    res.status(error.status || 500).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// HISTORIQUE DES MATCHS D'UNE ÉQUIPE
app.get("/api/teams/:id/matches", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Identifiant équipe invalide"
      });
    }

    const result = await footballRequest(
      `/teams/${id}/matches?limit=20`
    );

    res.json({
      status: "OK",
      team: result.team,
      totalMatches: (result.matches || []).length,
      matches: result.matches || []
    });

  } catch (error) {
    res.status(error.status || 500).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// GESTION DES ERREURS
app.use((req, res) => {
  res.status(404).json({
    status: "ERROR",
    message: "Route introuvable"
  });
});

// DÉMARRAGE SERVEUR
app.listen(PORT, () => {
  console.log("--------------------------------");
  console.log("DRABO73 VIP PRONOS");
  console.log("Serveur actif sur le port " + PORT);
  console.log("Football API:", API_KEY ? "CONFIGURED" : "NOT CONFIGURED");
  console.log("--------------------------------");
});
