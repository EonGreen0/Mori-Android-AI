export async function onRequest(context) {
  return context.env.MORI_SYNC.fetch(context.request);
}
