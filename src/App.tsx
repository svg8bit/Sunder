import { lazy, Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import { AppShell, useAppRoute, type RouteId } from "./components/shell";
import { useNetwork } from "./state/network";

const LaunchStudioScreen = lazy(() => import("./screens/launch-studio").then((module) => ({ default: module.LaunchStudioScreen })));
const SniperScreen = lazy(() => import("./screens/sniper").then((module) => ({ default: module.SniperScreen })));
const operations = () => import("./screens/operations");
const DashboardScreen = lazy(() => operations().then((module) => ({ default: module.DashboardScreen })));
const ProjectsScreen = lazy(() => operations().then((module) => ({ default: module.ProjectsScreen })));
const WalletsScreen = lazy(() => operations().then((module) => ({ default: module.WalletsScreen })));
const XidScreen = lazy(() => operations().then((module) => ({ default: module.XidScreen })));
const LeadersScreen = lazy(() => operations().then((module) => ({ default: module.LeadersScreen })));
const SwapManagerScreen = lazy(() => operations().then((module) => ({ default: module.SwapManagerScreen })));
const AuditScreen = lazy(() => operations().then((module) => ({ default: module.AuditScreen })));
const TrackerScreen = lazy(() => operations().then((module) => ({ default: module.TrackerScreen })));
const SettingsScreen = lazy(() => operations().then((module) => ({ default: module.SettingsScreen })));
const DocsScreen = lazy(() => operations().then((module) => ({ default: module.DocsScreen })));

function Screen({ route, navigate }: { readonly route: RouteId; readonly navigate: (route: RouteId) => void }) {
  switch (route) {
    case "dashboard": return <DashboardScreen navigate={navigate} />;
    case "launch": return <LaunchStudioScreen />;
    case "sniper": return <SniperScreen />;
    case "projects": return <ProjectsScreen navigate={navigate} />;
    case "wallets": return <WalletsScreen />;
    case "xid": return <XidScreen />;
    case "leaders": return <LeadersScreen />;
    case "swap": return <SwapManagerScreen />;
    case "audit": return <AuditScreen />;
    case "tracker": return <TrackerScreen />;
    case "settings": return <SettingsScreen />;
    case "docs": return <DocsScreen />;
  }
}

export function App() {
  const { route, navigate } = useAppRoute();
  const { network } = useNetwork();
  return (
    <AppShell route={route} navigate={navigate}>
      <Suspense fallback={<div className="screen-loading"><LoaderCircle className="spin" size={22} /> Loading console…</div>}>
        <Screen key={`${route}:${network}`} route={route} navigate={navigate} />
      </Suspense>
    </AppShell>
  );
}
