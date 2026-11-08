import { ROUTE_ACCESS, type RouteAccess } from '@mawsool/types';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** What the caller must be. Every route declares exactly one value; startup throws if one is missing. */
    access?: RouteAccess;
    /** Staff routes under /tickets must say they apply the facility scope. */
    facilityScoped?: boolean;
  }
  interface FastifyInstance {
    routeRegistry: RegisteredRoute[];
  }
}

export interface RegisteredRoute {
  method: string;
  url: string;
  access: RouteAccess;
}

const TICKET_PATH = /^\/tickets(\/|$)/;
const HANDOFF_PATH = /^\/crisis-handoffs(\/|$)/;
const CLINIC_LINK_PATH = /^\/clinic-link\//;

/**
 * Installs the route registry. Must be registered before any route.
 *
 * Every route must declare `config.access`, and the app fails to start if one does not or declares an unknown
 * value. A clinician route under /tickets must also declare `config.facilityScoped`, so a new ticket route
 * cannot ship without the facility scope. The recorded list is what the access test walks.
 */
export function registerRouteRegistry(app: FastifyInstance): void {
  const registry: RegisteredRoute[] = [];
  app.decorate('routeRegistry', registry);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method.join(',') : route.method;
    const where = `${methods} ${route.url}`;
    const access = route.config?.access;
    if (access === undefined || !(ROUTE_ACCESS as readonly string[]).includes(access)) {
      throw new Error(`Route ${where} must declare config.access as one of: ${ROUTE_ACCESS.join(', ')}`);
    }
    if (access === 'clinician' && TICKET_PATH.test(route.url) && route.config?.facilityScoped !== true) {
      throw new Error(`Route ${where} serves clinicians ticket data and must declare config.facilityScoped: true`);
    }
    if (access === 'crisis_line' && !HANDOFF_PATH.test(route.url)) {
      throw new Error(`Route ${where} gives the crisis-line role access outside /crisis-handoffs; that role may read only hand-offs the person consented to`);
    }
    if (access === 'clinic_link' && !CLINIC_LINK_PATH.test(route.url)) {
      throw new Error(`Route ${where} gives the no-login clinic link access outside /clinic-link/; a link may only open or act on its one ticket`);
    }
    registry.push({ method: methods, url: route.url, access });
  });
}
