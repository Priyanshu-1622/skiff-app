import { createRouter, createRoute, createRootRoute } from "@tanstack/react-router";
import { RootLayout } from "@/routes/__root";
import { UnlockRoute } from "@/routes/unlock";
import { DashboardRoute } from "@/routes/dashboard";
import { TerminalRoute } from "@/routes/terminal";
import { SettingsRoute } from "@/routes/settings";
import { TeamLoginRoute } from "@/routes/team-login";
import { TeamAdminRoute } from "@/routes/team-admin";
import { SetupRoute } from "@/routes/setup";
import { RecordingsRoute } from "@/routes/recordings";
import { AuditRoute } from "@/routes/audit";
import { ApprovalsRoute } from "@/routes/approvals";
import { FilesRoute } from "@/routes/files";
import { TunnelsRoute } from "@/routes/tunnels";
import { SnippetsRoute } from "@/routes/snippets";
import { PreviewRoute } from "@/routes/preview";

const rootRoute = createRootRoute({ component: RootLayout });

const unlockRoute = createRoute({ getParentRoute: () => rootRoute, path: "/unlock", component: UnlockRoute });
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardRoute });
const terminalRoute = createRoute({ getParentRoute: () => rootRoute, path: "/terminal/$hostId", component: TerminalRoute });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsRoute });
const teamLoginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: TeamLoginRoute });
const teamAdminRoute = createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: TeamAdminRoute });
const setupRoute = createRoute({ getParentRoute: () => rootRoute, path: "/setup", component: SetupRoute });
const recordingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/recordings", component: RecordingsRoute });
const auditRoute = createRoute({ getParentRoute: () => rootRoute, path: "/audit", component: AuditRoute });
const approvalsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/approvals", component: ApprovalsRoute });
const filesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/files", component: FilesRoute });
const tunnelsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tunnels", component: TunnelsRoute });
const snippetsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/snippets", component: SnippetsRoute });
const previewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/preview", component: PreviewRoute });

const routeTree = rootRoute.addChildren([unlockRoute, dashboardRoute, terminalRoute, settingsRoute, teamLoginRoute, teamAdminRoute, setupRoute, recordingsRoute, auditRoute, approvalsRoute, filesRoute, tunnelsRoute, snippetsRoute, previewRoute]);
export const router = createRouter({ routeTree });
declare module "@tanstack/react-router" { interface Register { router: typeof router; } }
