export default function handler(req, res) {
  if (req.method === "POST") {
    try {
      const { name, cin } = req.body;

      // Debug log (appears in Vercel logs)
      console.log("Login request:", name, cin);

      // Example response
      res.status(200).json({
        success: true,
        message: "Login received",
        user: { name, cin }
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: "Internal Server Error" });
    }
  } else {
    // If it's not a POST request
    res.status(405).json({ error: "Method Not Allowed" });
  }
}
