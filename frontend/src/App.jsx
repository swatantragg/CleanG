import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Branch from "./pages/Branch.jsx";
import Standardize from "./pages/Standardize.jsx";
import Export from "./pages/Export.jsx";
import AdminUsers from "./pages/AdminUsers.jsx";
import ChangePassword from "./pages/ChangePassword.jsx";

function RequireAuth({ children, adminOnly = false }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  // A pending forced password change blocks the whole app (the API returns 403
  // for everything else anyway) until the user sets a new password.
  if (user.must_change_password) return <ChangePassword forced />;
  if (adminOnly && user.role !== "admin")
    return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { user } = useAuth();

  return (
    <>
      <span className="version-badge">SKV2.4.1</span>
      <span className="made-by">Developed By Rahul and SK</span>
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
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
