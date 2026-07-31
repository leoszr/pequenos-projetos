import { readModelPolicy } from "../src/models/policy.ts";

const policy = await readModelPolicy(new URL("../src/models/default-policy.json", import.meta.url).pathname);
process.stdout.write(JSON.stringify(policy.models.map((model) => model.id)));

