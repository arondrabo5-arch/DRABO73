
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const API = "https://api.football-data.org/v4";

function burkinaDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Ouagadougou",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return burkinaDate(d);
}

async function getMatches(from, to) {
  if (!API_KEY) {
    throw new Error("Jeton API non configuré");
  }

  const response = await fetch(
    `${API}/matches?dateFrom=${from}&dateTo=${to}`,
    {
      headers: { "X-Auth-Token": API_KEY }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.message || "Erreur football-data.org"
    );
  }

  return data.matches || [];
}

function formatMatches(matches) {
  return matches.map(m => ({
    id: m.id,
    date: m.utcDate,
    status: m.status,
    competition: m.competition?.name,
    competitionCode: m.competition?.code,
    homeTeam: {
      id: m.homeTeam?.id,
      name: m.homeTeam?.name,
      crest: m.homeTeam?.crest
    },
    awayTeam: {
      id: m.awayTeam?.id,
      name: m.awayTeam?.name,
      crest: m.awayTeam?.crest
    },
    score: m.score
  }));
}

// ACCUEIL
app.get("/", (req, res) => {
  res.json({
    application: "DRABO73 VIP PRONOS",
    slogan: "LA CONFIANCE RESTE",
    status: "Serveur actif"
  });
});

// STATUT API
app.get("/api/status", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    football_api_configured: Boolean(API_KEY),
    api_connection: API_KEY ? "CONFIGURED" : "NOT_CONFIGURED",
    date: burkinaDate()
  });
});

// MATCHS DU JOUR
app.get("/api/matches/today", async (req, res) => {
  try {
    const today = burkinaDate();
    const matches = await getMatches(today, today);

    res.json({
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      category: "MATCHS DU JOUR",
      date: today,
      totalMatches: matches.length,
      message: matches.length
        ? "Matchs réels du jour récupérés"
        : "Aucun match disponible aujourd'hui",
      matches: formatMatches(matches)
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// MATCHS DES 7 PROCHAINS JOURS
app.get("/api/matches", async (req, res) => {
  try {
    const from = burkinaDate();
    const to = addDays(new Date(), 6);
    const matches = await getMatches(from, to);

    res.json({
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      dateFrom: from,
      dateTo: to,
      totalMatches: matches.length,
      message: "Rencontres réelles récupérées",
      matches: formatMatches(matches)
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// ANALYSES DES MATCHS
app.get("/api/analyses", async (req, res) => {
  try {
    const today = burkinaDate();
    const matches = await getMatches(today, addDays(new Date(), 6));

    res.json({
      status: "OK",
      message: "Rencontres disponibles pour analyse",
      totalMatches: matches.length,
      analyses: formatMatches(matches).map(m => ({
        matchId: m.id,
        competition: m.competition,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        matchDate: m.date,
        status: m.status,
        score: m.score,
        analysisStatus: "DONNEES A ANALYSER",
        prediction: null,
        confidence: null
      }))
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// PRONOSTICS VIP
app.get("/api/vip/predictions", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    message: "Espace pronostics VIP",
    predictions: [],
    note: "Aucun pronostic automatique inventé."
  });
});

// FORMULES VIP
app.get("/api/vip/plans", (req, res) => {
  res.json({
    status: "OK",
    currency: "FCFA",
    plans: [
      { duration: "7 jours", price: 5000 },
      { duration: "30 jours", price: 15000 },
      { duration: "90 jours", price: 35000 }
    ]
  });
});

// HISTORIQUE DES RESULTATS
app.get("/api/history", async (req, res) => {
  try {
    const from = addDays(new Date(), -7);
    const to = burkinaDate();

    const matches = await getMatches(from, to);

    const finished = matches.filter(m =>
      ["FINISHED", "AWARDED"].includes(m.status)
    );

    res.json({
      status: "OK",
      category: "HISTORIQUE DES RESULTATS",
      totalMatches: finished.length,
      results: formatMatches(finished)
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// PARAMETRES
app.get("/api/settings", (req, res) => {
  res.json({
    application: "DRABO73 VIP PRONOS",
    slogan: "LA CONFIANCE RESTE",
    timezone: "Africa/Ouagadougou",
    currency: "FCFA",
    apiConfigured: Boolean(API_KEY)
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

// DEMARRAGE
app.listen(PORT, () => {
  console.log(
    `DRABO73 VIP PRONOS actif sur le port ${PORT}`
  );
});
