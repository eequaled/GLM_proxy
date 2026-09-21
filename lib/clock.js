// Injectable clock interface to allow deterministic fast-forwarding in tests
export const defaultClock = {
  now: () => Date.now(),
};

// In-process test helper to temporarily override HOME / USERPROFILE to an isolated dir
export async function withFakeHome(fakeDir, fn) {
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeDir;
  process.env.USERPROFILE = fakeDir;
  try {
    return await fn();
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
  }
}
