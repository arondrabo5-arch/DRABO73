
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const API = "https://api.football-data.org/v4";

const CACHE_DURATION = 5 * 60 * 1000;
const HISTORY_CACHE = 30 * 60 * 1000;
const cache = new Map();

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

function addDays(date, days) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    return false;
  }

  const d = new Date(date + "T00:00:00Z");

  return !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === date;
}

function validatePeriod(from, to) {
  if (!validDate(from) || !validDate(to)) return false;

  const start = Date.parse(from + "T00:00:00Z");
  const end = Date.parse(to + "T00:00:00Z");

  const days = (end - start) / 86400000;

  return days >= 0 && days <= 9;
}

// CACHE
async function getCached(key, callback, duration = CACHE_DURATION) {
  const item = cache.get(key);

  if (item && Date.now() - item.time < duration) {
    return item.data;
  }

  const data = await callback();

  cache.set(key, {
    data,
    time: Date.now()
  });

  return data;
}

// FOOTBALL DATA API
async function footballRequest(endpoint) {
  if (!API_KEY) {
    throw new Error(
      "FOOTBALL_DATA_API_KEY absente dans Render."
    );
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
      throw new Error("Jeton Football-data.org invalide.");
    }

    if (response.status === 403) {
      throw new Error(
        "Accès refusé : compétition ou données non autorisées."
      );
    }

    if (response.status === 429) {
      throw new Error(
        "Limite API atteinte. Attends avant de réessayer."
      );
    }

    throw new Error(
      data.message || `Erreur API ${response.status}`
    );
  }

  return data;
}

// EXTRACTION DES SCORES
function getScore(match) {
  const score = match.score?.fullTime || {};

  return {
    home: score.home ?? score.homeTeam ?? null,
    away: score.away ?? score.awayTeam ?? null
  };
}

// STATISTIQUES DES DERNIERS MATCHS
function calculateTeamStats(matches, teamId) {
  const finished = (matches || []).filter(match =>
    match.status === "FINISHED"
  );

  let played = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;

  for (const match of finished) {
    const score = getScore(match);

    if (score.home === null || score.away === null) continue;

    const isHome = match.homeTeam?.id === teamId;

    const scored = isHome ? score.home : score.away;
    const conceded = isHome ? score.away : score.home;

    played++;
    goalsFor += scored;
    goalsAgainst += conceded;

    if (scored > conceded) wins++;
    else if (scored === conceded) draws++;
    else losses++;
  }

  return {
    played,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    averageScored: played ? goalsFor / played : null,
    averageConceded: played ? goalsAgainst / played : null,
    form: played
      ? Math.round((wins * 3 + draws) / (played * 3) * 100)
      : null
  };
}

// MODÈLE DE POISSON POUR LES SCORES
function factorial(n) {
  let result = 1;

  for (let i = 2; i <= n; i++) {
    result *= i;
  }

  return result;
}

function poisson(lambda, goals) {
  return (
    Math.exp(-lambda) *
    Math.pow(lambda, goals) /
    factorial(goals)
  );
}

function generatePrediction(homeStats, awayStats) {
  if (
    !homeStats.played ||
    !awayStats.played ||
    homeStats.averageScored === null ||
    awayStats.averageScored === null
  ) {
    return {
      available: false,
      message: "Historique statistique insuffisant."
    };
  }

  // Estimation des buts à partir des résultats passés
  const homeGoals = Math.max(0.2, Math.min(3.5,
    (homeStats.averageScored + awayStats.averageConceded) / 2
  ));

  const awayGoals = Math.max(0.2, Math.min(3.5,
    (awayStats.averageScored + homeStats.averageConceded) / 2
  ));

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  const scores = [];

  for (let h = 0; h <= 6; h++) {
    for (let a = 0; a <= 6; a++) {
      const probability =
        poisson(homeGoals, h) *
        poisson(awayGoals, a);

      scores.push({
        score: `${h}-${a}`,
        probability
      });

      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;
    }
  }

  const total = homeWin + draw + awayWin;

  homeWin /= total;
  draw /= total;
  awayWin /= total;

  const doubleChance = {
    "1X": homeWin + draw,
    "X2": awayWin + draw
  };

  const sortedScores = scores.sort(
    (a, b) => b.probability - a.probability
  );

  const outcome = [
    { name: "1", probability: homeWin },
    { name: "N", probability: draw },
    { name: "2", probability: awayWin }
  ].sort((a, b) => b.probability - a.probability);

  return {
    available: true,
    expectedGoals: {
      home: Number(homeGoals.toFixed(2)),
      away: Number(awayGoals.toFixed(2))
    },
    probabilities: {
      homeWin: Number((homeWin * 100).toFixed(1)),
      draw: Number((draw * 100).toFixed(1)),
      awayWin: Number((awayWin * 100).toFixed(1))
    },
    doubleChance: {
      "1X": Number((doubleChance["1X"] * 100).toFixed(1)),
      "X2": Number((doubleChance["X2"] * 100).toFixed(1))
    },
    safestDoubleChance:
      doubleChance["1X"] >= doubleChance["X2"] ? "1X" : "X2",
    mainPrediction: outcome[0].name,
    exactScores: sortedScores.slice(0, 3).map(item => ({
      score: item.score,
      probability: Number((item.probability * 100).toFixed(1))
    })),
    confidence: Number((outcome[0].probability * 100).toFixed(1)),
    model: "Poisson basé sur les dix derniers matchs",
    warning: "Probabilités estimatives, sans garantie."
  };
}

// RÉCUPÉRATION DES MATCHS RÉELS
async function getMatches(dateFrom, dateTo, competition = "") {
  const key = `matches_${dateFrom}_${dateTo}_${competition}`;

  return getCached(key, async () => {
    let endpoint =
      `/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;

    if (competition) {
      endpoint += `&competitions=${encodeURIComponent(competition)}`;
    }

    const data = await footballRequest(endpoint);

    return data.matches || [];
  });
}

// HISTORIQUE RÉCENT D'UNE ÉQUIPE
async function getTeamHistory(teamId) {
  return getCached(
    `team_history_${teamId}`,
    async () => {
      const data = await footballRequest(
        `/teams/${teamId}/matches?status=FINISHED&limit=10`
      );

      return data.matches || [];
    },
    HISTORY_CACHE
  );
}

// ANALYSE COMPLÈTE D'UN MATCH
async function analyzeMatch(matchId) {
  const match = await getCached(
    `match_${matchId}`,
    () => footballRequest(`/matches/${matchId}`)
  );

  const homeId = match.homeTeam?.id;
  const awayId = match.awayTeam?.id;

  if (!homeId || !awayId) {
    throw new Error("Informations des équipes indisponibles.");
  }

  const [homeHistory, awayHistory] = await Promise.all([
    getTeamHistory(homeId),
    getTeamHistory(awayId)
  ]);

  const homeStats = calculateTeamStats(homeHistory, homeId);
  const awayStats = calculateTeamStats(awayHistory, awayId);

  const prediction = generatePrediction(homeStats, awayStats);

  return {
    status: "OK",
    match: {
      id: match.id,
      date: match.utcDate,
      status: match.status,
      competition: match.competition?.name,
      venue: match.venue,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      score: getScore(match)
    },
    analysis: {
      home: {
        team: match.homeTeam.name,
        statistics: homeStats
      },
      away: {
        team: match.awayTeam.name,
        statistics: awayStats
      },
      comparison: {
        attack:
          homeStats.averageScored === null ||
          awayStats.averageScored === null
            ? null
            : homeStats.averageScored >
              awayStats.averageScored
              ? match.homeTeam.name
              : match.awayTeam.name,
        defense:
          homeStats.averageConceded === null ||
          awayStats.averageConceded === null
            ? null
            : homeStats.averageConceded <
              awayStats.averageConceded
              ? match.homeTeam.name
              : match.awayTeam.name
      }
    },
    lineups: {
      home: match.homeTeam?.lineup || [],
      away: match.awayTeam?.lineup || [],
      homeFormation: match.homeTeam?.formation || null,
      awayFormation: match.awayTeam?.formation || null,
      available: Boolean(
        match.homeTeam?.lineup?.length ||
        match.awayTeam?.lineup?.length
      )
    },
    predictions: prediction
  };
}

// ACCUEIL
app.get("/", (req, res) => {
  res.json({
    application: "DRABO73 VIP PRONOS",
    slogan: "LA CONFIANCE RESTE",
    status: "Serveur actif",
    date: getBurkinaDate(),
    version: "2.0"
  });
});

// STATUT
app.get("/api/status", async (req, res) => {
  const result = {
    application: "DRABO73 VIP PRONOS",
    football_api_configured: Boolean(API_KEY),
    api_connection: "NOT_CONNECTED",
    date: getBurkinaDate()
  };

  if (!API_KEY) {
    return res.status(503).json({
      ...result,
      status: "ERROR",
      message: "Jeton API absent."
    });
  }

  try {
    await footballRequest("/competitions");

    res.json({
      ...result,
      status: "OK",
      api_connection: "CONNECTED",
      message: "Football-data.org connecté."
    });
  } catch (error) {
    res.status(502).json({
      ...result,
      status: "ERROR",
      message: error.message
    });
  }
});

// MATCHS DU JOUR OU D'UNE PÉRIODE
app.get("/api/matches", async (req, res) => {
  try {
    const today = getBurkinaDate();
    const dateFrom = req.query.dateFrom || today;
    const dateTo = req.query.dateTo || dateFrom;
    const competition = req.query.competition || "";

    if (!validatePeriod(dateFrom, dateTo)) {
      return res.status(400).json({
        status: "ERROR",
        message: "Période maximale : 10 jours."
      });
    }

    const matches = await getMatches(
      dateFrom,
      dateTo,
      competition
    );

    res.json({
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      api_connection: "CONNECTED",
      dateFrom,
      dateTo,
      totalMatches: matches.length,
      message: matches.length
        ? "Rencontres réelles récupérées."
        : "Aucune rencontre disponible.",
      matches
    });
  } catch (error) {
    res.status(502).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// DÉTAILS D'UN MATCH
app.get("/api/matches/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Identifiant invalide."
      });
    }

    const match = await getCached(
      `match_${id}`,
      () => footballRequest(`/matches/${id}`)
    );

    res.json({
      status: "OK",
      match
    });
  } catch (error) {
    res.status(502).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// ANALYSES
app.get("/api/analysis/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Identifiant invalide."
      });
    }

    const analysis = await analyzeMatch(id);
    res.json(analysis);
  } catch (error) {
    res.status(502).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// PRONOSTICS VIP
app.get("/api/predictions/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Identifiant invalide."
      });
    }

    const analysis = await analyzeMatch(id);

    res.json({
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      match: analysis.match,
      predictions: analysis.predictions,
      disclaimer: "Pronostics statistiques, jamais garantis."
    });
  } catch (error) {
    res.status(502).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// COMPÉTITIONS
app.get("/api/competitions", async (req, res) => {
  try {
    const data = await getCached(
      "competitions",
      () => footballRequest("/competitions"),
      HISTORY_CACHE
    );

    res.json({
      status: "OK",
      totalCompetitions: data.competitions?.length || 0,
      competitions: data.competitions || []
    });
  } catch (error) {
    res.status(502).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// RÉSULTATS TERMINÉS
app.get("/api/results", async (req, res) => {
  try {
    const today = getBurkinaDate();
    const dateFrom = req.query.dateFrom || addDays(today, -7);
    const dateTo = req.query.dateTo || today;

    if (!validatePeriod(dateFrom, dateTo)) {
      return res.status(400).json({
        status: "ERROR",
        message: "Période maximale : 10 jours."
      });
    }

    const matches = await getMatches(dateFrom, dateTo);

    const finished = matches.filter(
      match => match.status === "FINISHED"
    );

    res.json({
      status: "OK",
      dateFrom,
      dateTo,
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

// HISTORIQUE
app.get("/api/history", async (req, res) => {
  try {
    const today = getBurkinaDate();
    const dateFrom = req.query.dateFrom || addDays(today, -7);
    const dateTo = req.query.dateTo || today;

    if (!validatePeriod(dateFrom, dateTo)) {
      return res.status(400).json({
        status: "ERROR",
        message: "Période maximale : 10 jours."
      });
    }

    const matches = await getMatches(dateFrom, dateTo);

    const results = matches
      .filter(match => match.status === "FINISHED")
      .map(match => ({
        id: match.id,
        date: match.utcDate,
        competition: match.competition?.name,
        homeTeam: match.homeTeam?.name,
        awayTeam: match.awayTeam?.name,
        score: getScore(match)
      }));

    res.json({
      status: "OK",
      totalResults: results.length,
      results
    });
  } catch (error) {
    res.status(502).json({
      status: "ERROR",
      message: error.message
    });
  }
});

// ERREURS
app.use((req, res) => {
  res.status(404).json({
    status: "ERROR",
    message: "Route introuvable."
  });
});

// DÉMARRAGE
app.listen(PORT, () => {
  console.log(
    `DRABO73 VIP PRONOS actif sur le port ${PORT}`
  );
});
