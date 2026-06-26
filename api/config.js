// Vercel serverless: GET /api/config -> checkout links (from env)
export default function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*')
  res.status(200).json({
    free: process.env.PAY_FREE || '',
    single: process.env.PAY_SINGLE || '',
    sub: process.env.PAY_SUB || '',
  })
}
