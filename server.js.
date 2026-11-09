
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const FOOTBALL_API = "https://api.football-data.org/v4";

// Accueil
app.get("/", (req, res) => {
  res.json({
    application: "DRABO73 VIP PRONOS",
    message: "Bienvenue sur DRABO73",
    slogan: "La confiance reste",
    status: "Serveur actif"
  });
});

// Vérification du serveur
app.get("/api/status", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    football_api_configured: Boolean(API_KEY)
  });
});

// Matchs de football réels
app.get("/api/matches", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        status: "ERROR",
        message: "Clé FOOTBALL_DATA_API_KEY non configurée sur Render"
      });
    }

    const dateFrom = req.query.dateFrom;
    const dateTo = req.query.dateTo;

    const params = new URLSearchParams();

    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);

    const url =
      `${FOOTBALL_API}/matches` +
      (params.toString() ? `?${params.toString()}` : "");

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Auth-Token": API_KEY
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        status: "ERROR",
        message: "Erreur football-data.org",
        api_status: response.status,
        details: data
      });
    }

    return res.json({
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      totalMatches: data.resultSet?.count ?? data.matches?.length ?? 0,
      matches: data.matches || []
    });

  } catch (error) {
    console.error("Erreur matchs :", error.message);

    return res.status(500).json({
      status: "ERROR",
      message: "Impossible de récupérer les matchs",
      details: error.message
    });
  }
});

// Informations VIP
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

// Route inconnue
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
