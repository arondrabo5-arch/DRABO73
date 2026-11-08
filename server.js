nst express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    application: "DRABO73 VIP PRONOS",
    message: "Bienvenue sur DRABO73",
    slogan: "La confiance reste",
    status: "Serveur actif"
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DRABO73 lancé sur le port ${PORT}`);
});