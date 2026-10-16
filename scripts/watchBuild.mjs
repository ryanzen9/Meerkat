import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (!entry) throw new Error('Missing Vite entry point.');
process.argv.splice(1, 1);

// The coordinator records our PID before sending the start byte. If it dies
// at any point, EOF on this private pipe ends the build in this same process.
process.stdin.once('end', () => process.exit(0));
process.stdin.once('data', async () => {
  // Let Vite exit normally after a build rather than keeping it alive on stdin.
  process.stdin.unref();
  try {
    await import(pathToFileURL(entry).href);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
});
process.stdin.resume();
