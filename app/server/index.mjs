import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp, PROJECT_ROOT } from './app.mjs';
import { APP_NAME } from '../shared/app-identity.mjs';

export { createApp } from './app.mjs';

export async function startServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须是有效端口。');
  if (options.host && options.host !== '127.0.0.1') throw new Error('此服务只能监听 127.0.0.1。');
  const app = await createApp({
    dataDir: process.env.HARNESS_DATA_DIR || path.join(PROJECT_ROOT, 'data'),
    defaultWorkspace: process.env.HARNESS_WORKSPACE_DIR || path.join(PROJECT_ROOT, 'workspace'),
    distDir: path.join(PROJECT_ROOT, 'dist'),
    // A real installation starts with the bundled sample skills; tests build the app directly
    // and keep an empty directory.
    seedExternalSkills: true,
    ...(process.env.HARNESS_EXTERNAL_SKILLS_DIR ? { externalSkillsDir: process.env.HARNESS_EXTERNAL_SKILLS_DIR } : {}),
    ...options,
  });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  server.app = app;
  server.stop = async () => {
    await app.locals.harness.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  return server;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  try {
    const server = await startServer();
    console.log(`${APP_NAME} 已启动：http://127.0.0.1:${server.address().port}`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true;
      await server.stop();
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) {
    console.error(error?.code === 'EADDRINUSE' ? '端口已被占用，请打开已有服务或使用其他 PORT。' : 'Harness Gemini 启动失败，请检查运行环境和数据目录。');
    process.exitCode = 1;
  }
}
