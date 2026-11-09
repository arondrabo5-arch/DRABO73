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
let cacheTime = {};

function getBurkinaDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Ouagadougou",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function addDays(date, days) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function footballRequest(endpoint) {
  if (!API_KEY) {
    throw new Error("FOOTBALL_DATA_API_KEY non configurée sur Render");
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
    throw new Error(
      data.message || `Erreur Football API: ${response.status}`
    );
  }

  return data;
}

// ACCUEIL
app.get("/", (req, res) => {
  res.json({
    application: "DRABO73 VIP PRONOS",
    slogan: "LA CONFIANCE RESTE",
    status: "Serveur actif",
    date: getBurkinaDate()
  });
});

// STATUT DU SERVEUR ET API
app.get("/api/status", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    football_api_configured: Boolean(API_KEY),
    api_connection: API_KEY ? "CONFIGURED" : "NOT_CONFIGURED",
    date: getBurkinaDate()
  });
});

// MATCHS DU JOUR
app.get("/api/matches", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(503).json({
        status: "ERROR",
        message: "Jeton Football-data.org non configuré"
      });
    }

    const today = getBurkinaDate();
    const dateFrom = req.query.dateFrom || today;
    const dateTo = req.query.dateTo || today;

    const start = new Date(dateFrom + "T00:00:00Z");
    const end = new Date(dateTo + "T00:00:00Z");

    const days = Math.round(
      (end - start) / (24 * 60 * 60 * 1000)
    );

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      days < 0 ||
      days > 9
    ) {
      return res.status(400).json({
        status: "ERROR",
        message: "La période doit être comprise entre 1 et 10 jours."
      });
    }

    const competition = req.query.competition || "";

    const cacheKey = `${dateFrom}_${dateTo}_${competition}`;

    if (
      cache[cacheKey] &&
      Date.now() - cacheTime[cacheKey] < CACHE_DURATION
    ) {
      return res.json(cache[cacheKey]);
    }

    let endpoint =
      `/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;

    if (competition) {
      endpoint += `&competitions=${encodeURIComponent(competition)}`;
    }

    const data = await footballRequest(endpoint);

    const result = {
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      api_connection: "CONNECTED",
      dateFrom,
      dateTo,
      competition: competition || "Toutes les compétitions accessibles",
      totalMatches: data.matches ? data.matches.length : 0,
      message: data.matches && data.matches.length
        ? "Rencontres réelles récupérées"
        : "Aucune rencontre disponible pour cette période",
      matches: data.matches || []
    };

    cache[cacheKey] = result;
    cacheTime[cacheKey] = Date.now();

    res.json(result);

  } catch (error) {
    res.status(502).json({
      status: "ERROR",
      application: "DRABO73 VIP PRONOS",
      message: error.message
    });
  }
});

// COMPÉTITIONS DISPONIBLES
app.get("/api/competitions", async (req, res) => {
  try {
    const data = await footballRequest("/competitions");

    res.json({
      status: "OK",
      totalCompetitions: data.competitions
        ? data.competitions.length
        : 0,
      competitions: data.competitions || []
    });

  } catch (error) {
    res.status(502).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// RÉSULTATS DES MATCHS
app.get("/api/results", async (req, res) => {
  try {
    const today = getBurkinaDate();
    const dateFrom = req.query.dateFrom || addDays(today, -7);
    const dateTo = req.query.dateTo || today;

    const start = new Date(dateFrom + "T00:00:00Z");
    const end = new Date(dateTo + "T00:00:00Z");

    const days = Math.round(
      (end - start) / (24 * 60 * 60 * 1000)
    );

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      days < 0 ||
      days > 9
    ) {
      return res.status(400).json({
        status: "ERROR",
        message: "La période des résultats ne peut pas dépasser 10 jours."
      });
    }

    const data = await footballRequest(
      `/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`
    );

    const finished = (data.matches || []).filter(
      match => match.status === "FINISHED"
    );

    res.json({
      status: "OK",
      totalResults: finished.length,
      results: finished
    });

  } catch (error) {
    res.status(502).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// DÉMARRAGE
app.listen(PORT, () => {
  console.log(
    `DRABO73 VIP PRONOS actif sur le port ${PORT}`
  );
});