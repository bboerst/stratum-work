import { Clock } from "lucide-react";
import { defineVisual } from "../framework/types";
import PoolClocks from "./PoolClocks";
import { poolClocksSettings } from "./settings";

export default defineVisual({
  id: "pool-clocks",
  title: "Pool clocks",
  description: "The time some pools write into their coinbase, compared with the block header's ntime or our receive time.",
  icon: Clock,
  status: "lab",                 // not listed outside development; still served at /v/pool-clocks
  settings: poolClocksSettings,
  component: PoolClocks,
  about: [
    "When a pool builds a job, some pool software pushes its current Unix time into the coinbase scriptSig. The coinbase parser finds it as a 4-byte pushed value within two hours of the template's ntime. Pools that don't push one are listed below the chart.",
    "Compared with ntime, the offset is internal to the pool: how its job builder's clock relates to the header time it hands out. Compared with our receive time, it's the pool clock's skew against our collector's clock (synchronised by NTP), plus a few milliseconds of network latency and the time the job waited before it was sent.",
    "A stable offset is a property of the pool's backend. Several pools sharing one can mean shared infrastructure, but also just the same software and defaults: treat it as a hint, not proof.",
  ],
});
