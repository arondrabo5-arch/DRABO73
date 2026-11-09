
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const API = "https://api.football-data.org/v4";

let cache = null;
let cacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000;

// DATE BURKINA FASO
function burkinaDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Ouagadougou",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function shiftDate(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));

  return date.toISOString().slice(0, 10);
}

// RECUPERATION DES DONNEES REELLES
async function getDataset() {
  if (!API_KEY) {
    throw new Error("Jeton API non configuré");
  }

  if (cache && Date.now() - cacheTime < CACHE_DURATION) {
    return cache;
  }

  const today = burkinaDate();
  const from = shiftDate(today, -90);
  const to = shiftDate(today, 6);

  const url = new URL(`${API}/matches`);
  url.searchParams.set("dateFrom", from);
  url.searchParams.set("dateTo", to);
  url.searchParams.set("limit", "500");

  const response = await fetch(url, {
    headers: {
      "X-Auth-Token": API_KEY
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.message || `Erreur API ${response.status}`
    );
  }

  cache = data.matches || [];
  cacheTime = Date.now();

  return cache;
}

// FORMAT DES MATCHS
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

// RESULTATS TERMINES
function isFinished(match) {
  return ["FINISHED", "AWARDED"].includes(match.status)
    && Number.isInteger(match.score?.fullTime?.home)
    && Number.isInteger(match.score?.fullTime?.away);
}

// CALCUL DES STATISTIQUES DES EQUIPES
function teamStats(matches, teamId) {
  const games = matches
    .filter(m =>
      isFinished(m) &&
      (
        m.homeTeam?.id === teamId ||
        m.awayTeam?.id === teamId
      )
    )
    .sort((a, b) =>
      new Date(b.utcDate) - new Date(a.utcDate)
    )
    .slice(0, 8);

  let played = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;

  for (const match of games) {
    const home = match.homeTeam.id === teamId;
    const gf = home
      ? match.score.fullTime.home
      : match.score.fullTime.away;

    const ga = home
      ? match.score.fullTime.away
      : match.score.fullTime.home;

    played++;
    goalsFor += gf;
    goalsAgainst += ga;

    if (gf > ga) wins++;
    else if (gf === ga) draws++;
    else losses++;
  }

  return {
    played,
    goalsFor,
    goalsAgainst,
    averageGoalsFor: played ? goalsFor / played : null,
    averageGoalsAgainst: played ? goalsAgainst / played : null,
    wins,
    draws,
    losses,
    form: games.map(m => {
      const home = m.homeTeam.id === teamId;
      const gf = home
        ? m.score.fullTime.home
        : m.score.fullTime.away;
      const ga = home
        ? m.score.fullTime.away
        : m.score.fullTime.home;

      return gf > ga ? "V" : gf === ga ? "N" : "D";
    }).reverse()
  };
}

// FONCTION POISSON
function poisson(lambda, goals) {
  let factorial = 1;

  for (let i = 2; i <= goals; i++) {
    factorial *= i;
  }

  return Math.exp(-lambda) *
    Math.pow(lambda, goals) / factorial;
}

// MOTEUR DE PREDICTION
function analyzeMatch(match, matches) {
  const homeId = match.homeTeam?.id;
  const awayId = match.awayTeam?.id;

  if (!homeId || !awayId) {
    return null;
  }

  const history = matches.filter(m =>
    isFinished(m) &&
    m.competition?.id === match.competition?.id
  );

  const homeStats = teamStats(history, homeId);
  const awayStats = teamStats(history, awayId);

  const enoughData =
    homeStats.played >= 3 &&
    awayStats.played >= 3;

  if (!enoughData) {
    return {
      matchId: match.id,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
      analysisStatus: "DONNEES INSUFFISANTES",
      prediction: null,
      confidence: null,
      message: "Pas assez de résultats historiques pour produire une estimation fiable."
    };
  }

  const allHome = history.filter(m =>
    m.homeTeam?.id &&
    m.awayTeam?.id
  );

  let leagueHomeGoals = 1.4;
  let leagueAwayGoals = 1.1;

  if (allHome.length > 0) {
    leagueHomeGoals = allHome.reduce(
      (sum, m) => sum + (m.score.fullTime.home || 0), 0
    ) / allHome.length;

    leagueAwayGoals = allHome.reduce(
      (sum, m) => sum + (m.score.fullTime.away || 0), 0
    ) / allHome.length;
  }

  const homeAttack = homeStats.averageGoalsFor;
  const awayAttack = awayStats.averageGoalsFor;

  const homeDefense = homeStats.averageGoalsAgainst;
  const awayDefense = awayStats.averageGoalsAgainst;

  // Estimation des buts
  const lambdaHome = Math.max(0.15, Math.min(4.5,
    (homeAttack + awayDefense + leagueHomeGoals) / 3
  ));

  const lambdaAway = Math.max(0.15, Math.min(4.5,
    (awayAttack + homeDefense + leagueAwayGoals) / 3
  ));

  // Probabilites des scores
  const scores = [];

  let homeProbTotal = 0;
  let awayProbTotal = 0;
  let drawProbTotal = 0;

  for (let h = 0; h <= 6; h++) {
    for (let a = 0; a <= 6; a++) {
      const probability =
        poisson(lambdaHome, h) *
        poisson(lambdaAway, a);

      scores.push({
        home: h,
        away: a,
        probability
      });

      if (h > a) homeProbTotal += probability;
      else if (h < a) awayProbTotal += probability;
      else drawProbTotal += probability;
    }
  }

  const total =
    homeProbTotal + drawProbTotal + awayProbTotal;

  homeProbTotal /= total;
  drawProbTotal /= total;
  awayProbTotal /= total;

  const topScores = scores
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 3)
    .map(s => ({
      score: `${s.home}-${s.away}`,
      probability: Number(
        (s.probability / total * 100).toFixed(1)
      )
    }));

  const doubleChance = {
    "1X": Number(
      ((homeProbTotal + drawProbTotal) * 100).toFixed(1)
    ),
    "X2": Number(
      ((awayProbTotal + drawProbTotal) * 100).toFixed(1)
    )
  };

  const outcomes = [
    { choice: "1", probability: homeProbTotal },
    { choice: "N", probability: drawProbTotal },
    { choice: "2", probability: awayProbTotal }
  ];

  outcomes.sort((a, b) => b.probability - a.probability);

  const maxProbability = outcomes[0].probability;

  return {
    matchId: match.id,
    competition: match.competition.name,
    matchDate: match.utcDate,

    homeTeam: match.homeTeam.name,
    awayTeam: match.awayTeam.name,

    analysisStatus: "ESTIMATION DISPONIBLE",

    statistics: {
      home: homeStats,
      away: awayStats
    },

    estimatedGoals: {
      home: Number(lambdaHome.toFixed(2)),
      away: Number(lambdaAway.toFixed(2)),
      total: Number((lambdaHome + lambdaAway).toFixed(2))
    },

    probabilities: {
      homeWin: Number((homeProbTotal * 100).toFixed(1)),
      draw: Number((drawProbTotal * 100).toFixed(1)),
      awayWin: Number((awayProbTotal * 100).toFixed(1))
    },

    safestDoubleChance:
      doubleChance["1X"] >= doubleChance["X2"]
        ? { choice: "1X", probability: doubleChance["1X"] }
        : { choice: "X2", probability: doubleChance["X2"] },

    doubleChance,

    exactScores: topScores,

    estimatedConfidence: Number(
      (maxProbability * 100).toFixed(1)
    ),

    dataAvailability: {
      historicalResults: true,
      lineups: false,
      corners: false,
      possession: false,
      shots: false,
      midfieldStatistics: false
    },

    warning:
      "Estimations statistiques non garanties. Ce ne sont pas des certitudes."
  };
}

// ACCUEIL
app.get("/", (req, res) => {
  res.json({
    application: "DRABO73 VIP PRONOS",
    slogan: "LA CONFIANCE RESTE",
    status: "Serveur actif"
  });
});

// STATUT
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
    const matches = await getDataset();
    const today = burkinaDate();

    const result = matches.filter(m =>
      m.utcDate?.slice(0, 10) === today
    );

    res.json({
      status: "OK",
      category: "MATCHS DU JOUR",
      date: today,
      totalMatches: result.length,
      matches: formatMatches(result)
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// TOUS LES MATCHS DE LA PERIODE
app.get("/api/matches", async (req, res) => {
  try {
    const matches = await getDataset();
    const today = burkinaDate();
    const end = shiftDate(today, 6);

    const result = matches.filter(m => {
      const date = m.utcDate?.slice(0, 10);
      return date >= today && date <= end;
    });

    res.json({
      status: "OK",
      dateFrom: today,
      dateTo: end,
      totalMatches: result.length,
      matches: formatMatches(result)
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// ANALYSES
app.get("/api/analyses", async (req, res) => {
  try {
    const matches = await getDataset();
    const today = burkinaDate();
    const end = shiftDate(today, 6);

    const upcoming = matches.filter(m => {
      const date = m.utcDate?.slice(0, 10);
      return date >= today &&
        date <= end &&
        ["SCHEDULED", "TIMED"].includes(m.status);
    });

    const analyses = upcoming.map(m =>
      analyzeMatch(m, matches)
    ).filter(Boolean);

    res.json({
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      totalMatches: analyses.length,
      analyses
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// ANALYSE D'UN MATCH
app.get("/api/analyses/:id", async (req, res) => {
  try {
    const matches = await getDataset();

    const match = matches.find(m =>
      String(m.id) === req.params.id
    );

    if (!match) {
      return res.status(404).json({
        status: "ERROR",
        message: "Match introuvable"
      });
    }

    const analysis = analyzeMatch(match, matches);

    res.json({
      status: "OK",
      analysis
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// PRONOSTICS VIP
app.get("/api/vip/predictions", async (req, res) => {
  try {
    const matches = await getDataset();
    const today = burkinaDate();
    const end = shiftDate(today, 6);

    const upcoming = matches.filter(m => {
      const date = m.utcDate?.slice(0, 10);
      return date >= today &&
        date <= end &&
        ["SCHEDULED", "TIMED"].includes(m.status);
    });

    const predictions = upcoming.map(m =>
      analyzeMatch(m, matches)
    ).filter(m => m && m.analysisStatus === "ESTIMATION DISPONIBLE");

    res.json({
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      totalPredictions: predictions.length,
      predictions,
      note: "Estimations statistiques, aucune garantie de gain."
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// HISTORIQUE
app.get("/api/history", async (req, res) => {
  try {
    const matches = await getDataset();
    const today = burkinaDate();
    const from = shiftDate(today, -7);

    const results = matches.filter(m => {
      const date = m.utcDate?.slice(0, 10);
      return date >= from &&
        date <= today &&
        isFinished(m);
    });

    res.json({
      status: "OK",
      category: "HISTORIQUE DES RESULTATS",
      totalMatches: results.length,
      results: formatMatches(results)
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      message: error.message
    });
  }
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

// PARAMETRES
app.get("/api/settings", (req, res) => {
  res.json({
    application: "DRABO73 VIP PRONOS",
    slogan: "LA CONFIANCE RESTE",
    timezone: "Africa/Ouagadougou",
    currency: "FCFA",
    apiConfigured: Boolean(API_KEY),
    cacheDurationMinutes: 5
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
