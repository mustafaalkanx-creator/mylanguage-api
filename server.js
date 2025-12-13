const express = require("express");
const mysql = require("mysql2");
const app = express();
const port = 3000;
const db = mysql.createConnection({
  host: "45.9.190.222",
  user: "mariadb",
  password: "6BOpkhuFKquY3q1rcTtZZvUZsTu2weQOHvKMYBCPTmE6VVa3RuDZoCd0kd7vO0Rm",
  database: "default"
});

db.connect((err) => {
  if (err) {
    console.error("Veritabanı bağlantı hatası:", err);
    return;
  }
  console.log("MariaDB bağlantısı başarılı");
});

app.get("/", (req, res) => {
  res.send("API çalışıyor");
});

app.get("/words", (req, res) => {
  const sql = "SELECT word_id, word FROM words";

  db.query(sql, (err, results) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: "Veritabanı hatası" });
      return;
    }

    res.json(results);
  });
});


app.listen(port, () => {
  console.log(`API ${port} portunda çalışıyor`);
});
