// Express framework'ünü projeye dahil eder
const express = require("express");

// MariaDB / MySQL bağlantısı için mysql2 kütüphanesi
const mysql = require("mysql2/promise");


// Express uygulamasını başlatır
const app = express();

// sadece get değil tüm istekleri cevaplamasını sağlar.
app.use(express.json());

// Server'ın dinleyeceği port
const port = 3000;

// Veritabanı bağlantı ayarları
const db = mysql.createPool({
  host: "45.9.190.222",
  user: "mariadb",
  password: "6BOpkhuFKquY3q1rcTtZZvUZsTu2weQOHvKMYBCPTmE6VVa3RuDZoCd0kd7vO0Rm",
  database: "default",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Veritabanına bağlanmayı dener
(async () => {
  try {
    const connection = await db.getConnection();
    console.log("MariaDB bağlantısı başarılı");
    connection.release();
  } catch (err) {
    console.error("Veritabanı bağlantı hatası:", err);
  }
})();


// Ana URL: site çalışıyor mu kontrolü
app.get("/", (req, res) => {
  res.send("API çalışıyor");
});

// words endpoint'i words tablosundan kelimeleri çeker
app.get("/words", async (req, res) => {
  try {
    const sql = "SELECT word_id, word FROM words";
    const [rows] = await db.query(sql);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Veritabanı hatası" });
  }
});


// Server'ı başlatır
app.listen(3000, "0.0.0.0", () => {
  console.log("Server running on port 3000");
});

