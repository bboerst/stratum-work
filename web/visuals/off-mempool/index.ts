import { EyeOff } from "lucide-react";
import { defineVisual } from "../framework/types";
import OffMempool from "./OffMempool";
import { offMempoolSettings } from "./settings";

export default defineVisual({
  id: "off-mempool",
  title: "Unseen transactions",
  description: "Share of each block's transactions our node never had in its mempool before the block.",
  icon: EyeOff,
  status: "beta",
  settings: offMempoolSettings,
  component: OffMempool,
  about: [
    "One dot per block: of its transactions (not counting the coinbase), the share our node never had in its mempool before the block arrived. Transactions sent to a miner directly (accelerated or private) look like this, but so does anything our node simply never received or rejected by its relay policy. It measures what our node saw, not how a transaction travelled.",
    "The axis starts where the record does. Grey marks along the bottom are blocks with no data: blocks the recorder missed, and the first blocks after a recorder gap (transactions sent during a gap aren't in the record, so they would look unseen). No data is not zero. How it's measured: docs/methodology.md, \"Off-mempool transactions\".",
  ],
});
