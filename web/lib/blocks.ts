export async function getBlocks(n: number) {
    const res = await fetch(`http://backend:8001/blocks?n=${n}`);
    if (!res.ok) throw new Error("Failed to fetch blocks");
    return res.json();
  }