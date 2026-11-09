
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const FOOTBALL_API = "https://api.football-data.org/v4";

function getBurkinaDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Ouagadougou",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;

  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date;
}

async function footballRequest(path) {
  const response = await fetch(`${FOOTBALL_API}${path}`, {
    headers: {
      "X-Auth-Token": API_KEY
    },
    signal: AbortSignal.timeout(20000)
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data.message || "Erreur Football-data.org"
    );
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

// Accueil
app.get("/", (req, res) => {
  res.json({
    application: "DRABO73 VIP PRONOS",
    message: "Bienvenue sur DRABO73",
    slogan: "La confiance reste",
    status: "Serveur actif"
  });
});

// Statut
app.get("/api/status", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    football_api_configured: Boolean(API_KEY),
    date_burkina: getBurkinaDate()
  });
});

// Compétitions accessibles avec la clé API
app.get("/api/competitions", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        status: "ERROR",
        message: "Clé API non configurée"
      });
    }

    const data = await footballRequest("/competitions");

    const competitions = Array.isArray(data.competitions)
      ? data.competitions
      : [];

    res.json({
      status: "OK",
      totalCompetitions: competitions.length,
      competitions
    });

  } catch (error) {
    res.status(error.status || 500).json({
      status: "ERROR",
      message: error.message,
      details: error.details || null
    });
  }
});

// Matchs réels
app.get("/api/matches", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        status: "ERROR",
        message: "Clé API non configurée"
      });
    }

    const today = getBurkinaDate();
    const dateFrom = req.query.dateFrom || today;
    const dateTo = req.query.dateTo || today;
    const competition = req.query.competition;

    if (!validDate(dateFrom) || !validDate(dateTo)) {
      return res.status(400).json({
        status: "ERROR",
        message: "Dates invalides. Format YYYY-MM-DD."
      });
    }

    if (dateFrom > dateTo) {
      return res.status(400).json({
        status: "ERROR",
        message: "La date de début doit précéder la date de fin."
      });
    }

    const days =
      (Date.parse(dateTo) - Date.parse(dateFrom)) /
      86400000;

    if (days > 30) {
      return res.status(400).json({
        status: "ERROR",
        message: "Maximum 31 jours par recherche."
      });
    }

    const params = new URLSearchParams({
      dateFrom,
      dateTo
    });

    const endpoint = competition
      ? `/competitions/${encodeURIComponent(competition)}/matches?${params}`
      : `/matches?${params}`;

    const data = await footballRequest(endpoint);

    const matches = Array.isArray(data.matches)
      ? data.matches
      : [];

    res.json({
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      dateFrom,
      dateTo,
      competition: competition || "Toutes les compétitions accessibles",
      totalMatches: matches.length,
      message: matches.length
        ? "Rencontres réelles récupérées"
        : "Aucune rencontre disponible pour cette période",
      matches
    });

  } catch (error) {
    console.error("Erreur matchs:", error.message);

    res.status(error.status || 500).json({
      status: "ERROR",
      message: error.message,
      api_status: error.status || null,
      details: error.details || null
    });
  }
});

// Tarifs VIP
app.get("/api/vip", (req, res) => {
  res.json({
    application: "DRABO73 VIP PRONOS",
    slogan: "La confiance reste",
    plans: [
      { duration: "7 jours", price: 5000 },
      { duration: "30 jours", price: 15000 },
      { duration: "90 jours", price: 35000 }
    ]
  });
});

// Routes inconnues
app.use((req, res) => {
  res.status(404).json({
    status: "ERROR",
    message: "Route introuvable",
    route: req.path
  });
});

// Démarrage
app.listen(PORT, () => {
  console.log(
    `DRABO73 VIP PRONOS actif sur le port ${PORT}`
  );
});
