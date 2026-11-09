
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const FOOTBALL_API = "https://api.football-data.org/v4";

function getBurkinaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Ouagadougou",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(p => [p.type, p.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;

  const parsed = new Date(`${date}T00:00:00Z`);

  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date;
}

async function footballRequest(path) {
  if (!API_KEY) {
    throw new Error("FOOTBALL_DATA_API_KEY non configurée");
  }

  const response = await fetch(`${FOOTBALL_API}${path}`, {
    headers: {
      "X-Auth-Token": API_KEY,
      "Accept": "application/json"
    },
    signal: AbortSignal.timeout(20000)
  });

  const raw = await response.text();

  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: "Réponse API illisible" };
  }

  if (!response.ok) {
    const messages = {
      400: "Requête API incorrecte",
      401: "Jeton API invalide",
      403: "Accès refusé : compétition non autorisée ou abonnement limité",
      404: "Ressource API introuvable",
      429: "Limite de requêtes API atteinte. Réessayer plus tard"
    };

    const error = new Error(
      messages[response.status] ||
      data.message ||
      "Erreur Football-data.org"
    );

    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

function sendError(res, error) {
  console.error("Football API:", error.message);

  res.status(error.status || 502).json({
    status: "ERROR",
    application: "DRABO73 VIP PRONOS",
    message: error.message,
    api_status: error.status || null,
    details: error.details || null
  });
}

// ACCUEIL
app.get("/", (req, res) => {
  res.json({
    application: "DRABO73 VIP PRONOS",
    message: "Bienvenue sur DRABO73",
    slogan: "La confiance reste",
    status: "Serveur actif"
  });
});

// STATUT
app.get("/api/status", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    football_api_configured: Boolean(API_KEY),
    date_burkina: getBurkinaDate()
  });
});

// DIAGNOSTIC API
app.get("/api/diagnostic", async (req, res) => {
  try {
    const today = getBurkinaDate();
    const dateTo = addDays(today, 6);

    const competitionsData =
      await footballRequest("/competitions");

    const matchesParams = new URLSearchParams({
      dateFrom: today,
      dateTo
    });

    const matchesData = await footballRequest(
      `/matches?${matchesParams}`
    );

    const competitions = Array.isArray(
      competitionsData.competitions
    ) ? competitionsData.competitions : [];

    const matches = Array.isArray(
      matchesData.matches
    ) ? matchesData.matches : [];

    res.json({
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      api_connection: "CONNECTED",
      dateFrom: today,
      dateTo,
      totalCompetitions: competitions.length,
      totalMatches: matches.length,
      competitions,
      matches,
      message: matches.length
        ? "API connectée : rencontres récupérées"
        : "API connectée : aucune rencontre dans cette période"
    });

  } catch (error) {
    sendError(res, error);
  }
});

// COMPÉTITIONS ACCESSIBLES
app.get("/api/competitions", async (req, res) => {
  try {
    const data = await footballRequest("/competitions");

    const competitions = Array.isArray(data.competitions)
      ? data.competitions
      : [];

    res.json({
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      totalCompetitions: competitions.length,
      competitions
    });

  } catch (error) {
    sendError(res, error);
  }
});

// MATCHS RÉELS
// Par défaut : aujourd'hui + 6 jours
app.get("/api/matches", async (req, res) => {
  try {
    const today = getBurkinaDate();

    const dateFrom = req.query.dateFrom || today;
    const dateTo = req.query.dateTo ||
      addDays(dateFrom, 6);

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
      competition: competition ||
        "Toutes les compétitions accessibles",
      totalMatches: matches.length,
      message: matches.length
        ? "Rencontres réelles récupérées"
        : "Aucune rencontre disponible pour cette période",
      matches
    });

  } catch (error) {
    sendError(res, error);
  }
});

// TARIFS VIP
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

// ROUTES INCONNUES
app.use((req, res) => {
  res.status(404).json({
    status: "ERROR",
    message: "Route introuvable",
    route: req.path
  });
});

// DÉMARRAGE
app.listen(PORT, () => {
  console.log(
    `DRABO73 VIP PRONOS actif sur le port ${PORT}`
  );
});
