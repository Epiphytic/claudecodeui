// hooks/useVersionCheck.js
import { useState, useEffect } from "react";
import { version } from "../../package.json";

// Default npm package to check for updates
// Can be overridden via VITE_NPM_PACKAGE environment variable
const DEFAULT_NPM_PACKAGE = "@epiphytic/claudecodeui";

/**
 * Hook to check for version updates from npm registry
 *
 * @param {string} [packageName] - Optional override for the npm package name
 * @returns {Object} { updateAvailable, latestVersion, currentVersion, packageInfo }
 */
export const useVersionCheck = (packageName = null) => {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState(null);
  const [packageInfo, setPackageInfo] = useState(null);

  // Determine which package to check
  // Priority: 1. Passed parameter, 2. Environment variable, 3. Default
  const npmPackage =
    packageName || import.meta.env.VITE_NPM_PACKAGE || DEFAULT_NPM_PACKAGE;

  useEffect(() => {
    const checkVersion = async () => {
      try {
        // Encode package name for URL (handles scoped packages like @org/name)
        const encodedPackage = encodeURIComponent(npmPackage);

        // Fetch package info from npm registry
        const response = await fetch(
          `https://registry.npmjs.org/${encodedPackage}/latest`,
        );

        if (!response.ok) {
          // Package not found or registry error
          console.warn(`Version check: Package ${npmPackage} not found on npm`);
          setUpdateAvailable(false);
          setLatestVersion(null);
          setPackageInfo(null);
          return;
        }

        const data = await response.json();

        if (data.version) {
          const latest = data.version;
          setLatestVersion(latest);

          // Compare versions (simple string comparison works for semver)
          setUpdateAvailable(isNewerVersion(latest, version));

          // Store package information
          setPackageInfo({
            name: data.name,
            description: data.description || "",
            homepage:
              data.homepage || `https://www.npmjs.com/package/${npmPackage}`,
            repository: data.repository?.url || null,
          });
        } else {
          setUpdateAvailable(false);
          setLatestVersion(null);
          setPackageInfo(null);
        }
      } catch (error) {
        console.error("Version check failed:", error);
        // On error, don't show update notification
        setUpdateAvailable(false);
        setLatestVersion(null);
        setPackageInfo(null);
      }
    };

    checkVersion();
    const interval = setInterval(checkVersion, 5 * 60 * 1000); // Check every 5 minutes
    return () => clearInterval(interval);
  }, [npmPackage]);

  return {
    updateAvailable,
    latestVersion,
    currentVersion: version,
    packageInfo,
  };
};

/**
 * Compare two semver versions to determine if target is newer than current
 *
 * @param {string} target - The version to compare against
 * @param {string} current - The current version
 * @returns {boolean} True if target is newer than current
 */
function isNewerVersion(target, current) {
  const targetParts = target.split(".").map((p) => parseInt(p, 10) || 0);
  const currentParts = current.split(".").map((p) => parseInt(p, 10) || 0);

  // Pad arrays to same length
  const maxLength = Math.max(targetParts.length, currentParts.length);
  while (targetParts.length < maxLength) targetParts.push(0);
  while (currentParts.length < maxLength) currentParts.push(0);

  // Compare each part
  for (let i = 0; i < maxLength; i++) {
    if (targetParts[i] > currentParts[i]) return true;
    if (targetParts[i] < currentParts[i]) return false;
  }

  return false; // Versions are equal
}

// For backwards compatibility, also export with legacy signature
// This wrapper handles the old (owner, repo) pattern and ignores those params
export const useVersionCheckLegacy = (_owner, _repo) => {
  return useVersionCheck();
};
