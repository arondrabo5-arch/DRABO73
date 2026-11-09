const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const API = "https://api.football-data.org/v4";

const CACHE_DURATION = 5 * 60 * 1000;
const cache = new Map();

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

function addDays(date, days) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;

  const d = new Date(date + "T00:00:00Z");

  return !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === date;
}

function validatePeriod(dateFrom, dateTo) {
  if (!validDate(dateFrom) || !validDate(dateTo)) {
    return false;
  }

  const start = Date.parse(dateFrom + "T00:00:00Z");
  const end = Date.parse(dateTo + "T00:00:00Z");

  const days = (end - start) / 86400000;

  return days >= 0 && days <= 9;
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
    },
    signal: AbortSignal.timeout(15000)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Jeton API invalide (401). Vérifie FOOTBALL_DATA_API_KEY.");
    }

    if (response.status === 403) {
      throw new Error("Accès refusé (403). Vérifie les compétitions autorisées.");
    }

    if (response.status === 429) {
      throw new Error("Limite de requêtes API atteinte. Réessaie plus tard.");
    }

    throw new Error(
      data.message || `Erreur Football-data.org : ${response.status}`
    );
  }

  return data;
}

async function getCached(key, callback) {
  const item = cache.get(key);

  if (item && Date.now() - item.time < CACHE_DURATION) {
    return item.data;
  }

  const data = await callback();

  cache.set(key, {
    data,
    time: Date.now()
  });

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

// STATUT ET VÉRIFICATION RÉELLE API
app.get("/api/status", async (req, res) => {
  const result = {
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    football_api_configured: Boolean(API_KEY),
    api_connection: "NOT_CONNECTED",
    date: getBurkinaDate()
  };

  if (!API_KEY) {
    return res.status(503).json({
      ...result,
      status: "ERROR",
      message: "Jeton API absent"
    });
  }

  try {
    await footballRequest("/competitions");

    result.api_connection = "CONNECTED";
    result.message = "Connexion Football-data.org réussie";

    res.json(result);
  } catch (error) {
    res.status(502).json({
      ...result,
      status: "ERROR",
      message: error.message
    });
  }
});

// MATCHS DU JOUR ET AUTRES DATES
app.get("/api/matches", async (req, res) => {
  try {
    const today = getBurkinaDate();

    const dateFrom = req.query.dateFrom || today;
    const dateTo = req.query.dateTo || dateFrom;

    if (!validatePeriod(dateFrom, dateTo)) {
      return res.status(400).json({
        status: "ERROR",
        message: "La période doit être comprise entre 1 et 10 jours."
      });
    }

    const competition = req.query.competition || "";

    const key = `matches_${dateFrom}_${dateTo}_${competition}`;

    const result = await getCached(key, async () => {
      let endpoint =
        `/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;

      if (competition) {
        endpoint += `&competitions=${encodeURIComponent(competition)}`;
      }

      const data = await footballRequest(endpoint);
      const matches = data.matches || [];

      return {
        status: "OK",
        application: "DRABO73 VIP PRONOS",
        api_connection: "CONNECTED",
        dateFrom,
        dateTo,
        competition: competition || "Toutes les compétitions accessibles",
        totalMatches: matches.length,
        message: matches.length
          ? "Rencontres réelles récupérées"
          : "Aucune rencontre disponible pour cette période",
        matches
      };
    });

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
    const data = await getCached("competitions", () =>
      footballRequest("/competitions")
    );

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

// HISTORIQUE DES RÉSULTATS
app.get("/api/results", async (req, res) => {
  try {
    const today = getBurkinaDate();

    const dateFrom = req.query.dateFrom || addDays(today, -7);
    const dateTo = req.query.dateTo || today;

    if (!validatePeriod(dateFrom, dateTo)) {
      return res.status(400).json({
        status: "ERROR",
        message: "La période des résultats ne peut pas dépasser 10 jours."
      });
    }

    const key = `results_${dateFrom}_${dateTo}`;

    const result = await getCached(key, async () => {
      const data = await footballRequest(
        `/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`
      );

      const finished = (data.matches || []).filter(
        match => match.status === "FINISHED"
      );

      return {
        status: "OK",
        totalResults: finished.length,
        results: finished
      };
    });

    res.json(result);

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