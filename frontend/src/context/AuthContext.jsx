// Authentication state: token persistence, login/signup/logout, session restore.

import { createContext, useContext, useEffect, useState } from "react";
import { authApi } from "../api/auth";
import { setToken, getToken } from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);

  // On load, if a token exists, confirm it's still valid.
  useEffect(() => {
    (async () => {
      if (!getToken()) {
        setBooting(false);
        return;
      }
      try {
        const me = await authApi.me();
        setUser(me);
      } catch {
        setToken(null);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  const login = async (email, password) => {
    const res = await authApi.login(email, password);
    setToken(res.access_token);
    setUser({ email: res.email, role: res.role, name: res.name });
  };

  const signup = async (email, password, name) => {
    const res = await authApi.signup(email, password, name);
    setToken(res.access_token);
    setUser({ email: res.email, role: res.role, name: res.name });
  };

  const logout = () => {
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, booting, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
