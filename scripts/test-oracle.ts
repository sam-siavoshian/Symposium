import { NiaSDK } from "nia-ai-ts";

const key = process.env.NIA_API_KEY;
if (!key) { console.error("No NIA_API_KEY"); process.exit(1); }

const sdk = new NiaSDK({ apiKey: key });

console.log("Creating Oracle job...");
const job = await sdk.oracle.createJob({ query: "Say hello" });
const jobId = (job as any).id || (job as any).job_id;
console.log("Job ID:", jobId);

console.log("Waiting for result...");
const result = await sdk.oracle.waitForJob(jobId, 60_000, 3000);

console.log("Result type:", typeof result);
console.log("Result keys:", Object.keys(result).join(", "));
console.log("Has final_report:", "final_report" in result);
console.log("final_report:", String((result as any).final_report ?? "UNDEFINED").slice(0, 200));
console.log("Has answer:", "answer" in result);
console.log("Has result_field:", "result" in result);

process.exit(0);
