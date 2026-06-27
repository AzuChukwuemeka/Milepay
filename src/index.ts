import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import { connectDB } from './config/database';
import { runMigrations } from './db/migrate';
import { swaggerSpec } from './config/swagger';
import routes from './routes/index';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { startCronJobs } from './services/cron.service';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security Middleware ──────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "unpkg.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "unpkg.com"],
        imgSrc: ["'self'", "data:", "unpkg.com"],
      },
    },
  })
);

app.use(cors({
  origin: [
    process.env.APP_URL || 'http://localhost:3001',
    'http://localhost:3000',
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' } },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many auth attempts' } },
});

app.use(globalLimiter);
app.use('/v1/auth', authLimiter);

// ─── Body Parsing ─────────────────────────────────────────────────────────────
// Raw body for webhook signature verification
app.use('/v1/webhooks/nomba', express.raw({ type: 'application/json' }), (req, _res, next) => {
  if (Buffer.isBuffer(req.body)) {
    req.body = JSON.parse(req.body.toString());
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
// ─── Swagger Docs ─────────────────────────────────────────────────────────────
app.get('/docs.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

app.get('/docs', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>MilePay API Docs</title>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css" >
        <style>
          .topbar { background-color: #0D3B2B !important; }
          .topbar-wrapper img { display: none; }
          .topbar-wrapper::after { content: "MilePay API"; color: #C98A1A; font-size: 20px; font-weight: bold; margin-left: 16px; }
        </style>
      </head>
      <body>
        <div id="swagger-ui"></div>
        <script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"> </script>
        <script src="https://unpkg.com/swagger-ui-dist/swagger-ui-standalone-preset.js"> </script>
        <script>
          window.onload = function() {
            SwaggerUIBundle({
              url: "/docs.json",
              dom_id: '#swagger-ui',
              presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
              layout: "StandaloneLayout",
              persistAuthorization: true,
              displayRequestDuration: true,
              docExpansion: 'none',
              filter: true
            })
          }
        </script>
      </body>
    </html>
  `);
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
    console.log(`\n🚀 MilePay API running on http://localhost:${PORT}`);
    console.log(`📚 Swagger docs at http://localhost:${PORT}/docs`);
    console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}\n`);
  });
};

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export default app;
