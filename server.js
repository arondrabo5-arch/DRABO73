
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const FOOTBALL_API = "https://api.football-data.org/v4";

// DATE DU BURKINA FASO
function getBurkinaDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Ouagadougou",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
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
    date: getBurkinaDate()
  });
});

// MATCHS REELS
app.get("/api/matches", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(503).json({
        status: "ERROR",
        message: "Jeton football-data.org non configuré"
      });
    }

    const dateFrom = getBurkinaDate();
    const future = new Date();
    future.setDate(future.getDate() + 6);

    const dateTo = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Ouagadougou",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(future);

    const response = await fetch(
      `${FOOTBALL_API}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
      {
        headers: {
          "X-Auth-Token": API_KEY
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        status: "ERROR",
        message: "Erreur football-data.org",
        details: data.message || "Erreur API"
      });
    }

    const matches = (data.matches || []).map(match => ({
      id: match.id,
      utcDate: match.utcDate,
      status: match.status,
      matchday: match.matchday,
      competition: {
        id: match.competition?.id,
        name: match.competition?.name,
        code: match.competition?.code,
        emblem: match.competition?.emblem
      },
      homeTeam: {
        id: match.homeTeam?.id,
        name: match.homeTeam?.name,
        crest: match.homeTeam?.crest
      },
      awayTeam: {
        id: match.awayTeam?.id,
        name: match.awayTeam?.name,
        crest: match.awayTeam?.crest
      },
      score: match.score
    }));

    res.json({
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      api_connection: "CONNECTED",
      dateFrom,
      dateTo,
      totalMatches: matches.length,
      message: matches.length
        ? "Rencontres réelles récupérées"
        : "Aucune rencontre disponible pour cette période",
      matches
    });

  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: "Échec de connexion au serveur football",
      details: error.message
    });
  }
});

// FORMULES VIP
app.get("/api/vip/plans", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    currency: "FCFA",
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
