export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { config } = await import("./server/config");
  if (!config.workerEnabled) return;
  const { startWorker } = await import("./server/worker");
  startWorker();
}
