export async function writeText(stream, text) {
  if (!text) return;
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      stream.off("error", onError);
      reject(err);
    };
    stream.once("error", onError);
    stream.write(text, (err) => {
      stream.off("error", onError);
      if (err) reject(err);
      else resolve();
    });
  });
}
