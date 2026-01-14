const express = require("express");
const db = require("./config/db");
const app = express();
app.use(express.json());

app.get("/health", async (req, res) => {
  try {
    const { data, error } = await db
      .from("information_schema.tables")
      .select("table_name")
      .limit(1);
    res.json({
      status: "OK",
      connected: !error && data?.length > 0,
      tables: data?.map((r) => r.table_name) || [],
      error: error?.message || null,
    });
  } catch (err) {
    res.status(500).json({ status: "ERROR", message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
