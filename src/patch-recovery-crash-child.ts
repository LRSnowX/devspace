import { applyPatch } from "./apply-patch.js";
import { PatchRecoveryManager } from "./patch-recovery.js";

const [mode, stateDir, root, milestone] = process.argv.slice(2);
if (!mode || !stateDir || !root) throw new Error("Missing patch crash child arguments");
const manager = new PatchRecoveryManager(stateDir);
try {
  if (mode === "recover") {
    console.log(JSON.stringify(await manager.reconcileStartup()));
  } else if (mode === "recover-crash") {
    console.log(JSON.stringify(await manager.reconcileStartup({
      afterRecoveryMilestone: (name, index) => {
        if (name === milestone || `${name}:${index}` === milestone) process.exit(92);
      },
    })));
  } else if (mode === "patch" || mode === "patch-mixed") {
    const patch = mode === "patch" ? `*** Begin Patch
*** Update File: first.txt
@@
-old first
+new first
*** Update File: second.txt
@@
-old second
+new second
*** End Patch` : `*** Begin Patch
*** Add File: added.txt
+added
*** Delete File: second.txt
*** End Patch`;
    await applyPatch(root, patch, {
      journal: manager,
      afterRecoveryMilestone: (name, index) => {
        if (name === milestone || `${name}:${index}` === milestone) process.exit(91);
      },
    });
  } else {
    throw new Error(`Unknown patch crash child mode: ${mode}`);
  }
} finally {
  manager.close();
}
