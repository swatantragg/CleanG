import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Branch from "./pages/Branch.jsx";
import Standardize from "./pages/Standardize.jsx";
import Export from "./pages/Export.jsx";
import AdminUsers from "./pages/AdminUsers.jsx";
import MailSettings from "./pages/MailSettings.jsx";
import ChangePassword from "./pages/ChangePassword.jsx";
import { isAdmin, isSuperAdmin } from "./utils/roles.js";
import { APP_VERSION } from "./version.js";

function RequireAuth({ children, adminOnly = false, superAdminOnly = false }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  // A pending forced password change blocks the whole app (the API returns 403
  // for everything else anyway) until the user sets a new password.
  if (user.must_change_password) return <ChangePassword forced />;
  if (adminOnly && !isAdmin(user)) return <Navigate to="/" replace />;
  if (superAdminOnly && !isSuperAdmin(user)) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { user } = useAuth();

  return (
    <>
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/" replace /> : <Login />}
      />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/branches/:branchId" element={<Branch />} />
        <Route path="/standardize" element={<Standardize />} />
        <Route path="/export" element={<Export />} />
        <Route
          path="/users"
          element={
            <RequireAuth adminOnly>
              <AdminUsers />
            </RequireAuth>
          }
        />
        <Route
          path="/mail"
          element={
            <RequireAuth superAdminOnly>
              <MailSettings />
            </RequireAuth>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    {/* Real page footer: last thing in the document, so it scrolls with the page
        and only comes into view at the very bottom — never pinned over content. */}
    <footer className="app-footer">
      <span className="version-badge">V{APP_VERSION}</span>
    </footer>
    </>
  );
}
