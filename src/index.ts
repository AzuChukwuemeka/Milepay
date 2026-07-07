import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

dotenv.config();

import { connectDB } from './config/database';
import { runMigrations } from './db/migrate';
import { getSwaggerSpec } from './config/swagger';
import routes from './routes/index';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { startCronJobs } from './services/cron.service';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use('/v1/webhooks/nomba', express.raw({ type: 'application/json' }), (req, _res, next) => {
  if (Buffer.isBuffer(req.body)) {
    const rawBody = req.body.toString();
    (req as any).rawBody = rawBody;
    try {
      req.body = JSON.parse(rawBody);
    } catch {
      req.body = {};
    }
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'milepay-api', timestamp: new Date().toISOString() });
});

// ─── Swagger Docs ─────────────────────────────────────────────────────────────
app.get('/docs.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(getSwaggerSpec());
});

app.get('/docs', (_req, res) => {
  const apiUrl = process.env.API_URL || `http://localhost:${PORT}`;
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>MilePay API</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css">
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js" crossorigin></script>
    <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-standalone-preset.js" crossorigin></script>
    <script>
    window.onload = function() {
      const ui = SwaggerUIBundle({
        url: "${apiUrl}/docs.json",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout",
        persistAuthorization: true
      })
      window.ui = ui
    }
    </script>
  </body>
</html>`);
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/v1', routes);

// ─── Error Handling ───────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const bootstrap = async (): Promise<void> => {
  await connectDB();
  await runMigrations();
  startCronJobs();

  app.listen(PORT, () => {
    console.log(`\nMilePay API running on http://localhost:${PORT}`);
    console.log(`Swagger docs at http://localhost:${PORT}/docs`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}\n`);
  });
};

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export default app;
