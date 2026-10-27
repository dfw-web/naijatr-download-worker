import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "naijatr-download-worker"
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`naijatr-download-worker listening on port ${port}`);
});