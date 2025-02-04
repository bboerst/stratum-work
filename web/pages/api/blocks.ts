import type { NextApiRequest, NextApiResponse } from 'next'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const n = req.query.n || 20
  try {
    const backendRes = await fetch(`http://backend:8001/blocks?n=${n}`)
    if (!backendRes.ok) {
      res.status(backendRes.status).json({ error: 'Error fetching blocks from backend' })
      return
    }
    const data = await backendRes.json()
    res.status(200).json(data)
  } catch (error: any) {
    res.status(500).json({ error: 'Server error', details: error.message })
  }
}