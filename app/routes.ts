import { index, route, type RouteConfig } from '@react-router/dev/routes';
export default [index('routes/work.tsx'), route('api/*', 'routes/work-api.ts'), route('auth/*', 'routes/auth.ts'), route('health', 'routes/health.ts')] satisfies RouteConfig;
