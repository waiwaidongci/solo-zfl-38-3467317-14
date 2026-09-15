import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, defaultStore } from "./src/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);

const store = defaultStore(dbPath);
const server = createApp(store);
server.listen(port, () => console.log("古船模型帆索校准（含多索联调）listening on http://localhost:" + port));
