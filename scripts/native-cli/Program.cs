// Hosted Windows-only synthetic fixture. Not product code or an AI client.
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

internal sealed record FixtureConfig(string privateRoot, string nodeExecutable, string nodeSHA256,
    string agentScript, string agentSHA256, string journalDirectory);
internal static class Program
{
    private static string Hash(string file) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant();
    private static bool Inside(string root, string file) => file.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    private static void Regular(string file) {
        if (!Path.IsPathFullyQualified(file) || !File.Exists(file) || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Expected reviewed regular absolute fixture file");
    }
    private static async Task<int> Main(string[] args)
    {
        if (!OperatingSystem.IsWindows() || System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture != System.Runtime.InteropServices.Architecture.X64) return 83;
        try {
            string configPath = Path.Combine(AppContext.BaseDirectory, "fixture-config.json");
            Regular(configPath);
            if (new FileInfo(configPath).Length > 32768) throw new InvalidDataException("Fixture config too large");
            FixtureConfig cfg = JsonSerializer.Deserialize<FixtureConfig>(File.ReadAllText(configPath)) ?? throw new InvalidDataException("Missing fixture config");
            string root = Path.GetFullPath(cfg.privateRoot), script = Path.GetFullPath(cfg.agentScript), node = Path.GetFullPath(cfg.nodeExecutable);
            if (!Inside(root, script) || !Inside(root, Path.GetFullPath(cfg.journalDirectory))) throw new InvalidDataException("Fixture path outside private root");
            Regular(script); Regular(node);
            if (Hash(script) != cfg.agentSHA256 || Hash(node) != cfg.nodeSHA256) throw new InvalidDataException("Fixture input changed");
            Directory.CreateDirectory(cfg.journalDirectory);
            using Process own = Process.GetCurrentProcess();
            string launchNonce = Guid.NewGuid().ToString("D");
            string launcherStartTicks = own.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
            string journal = Path.Combine(cfg.journalDirectory, $"launcher-{Environment.ProcessId}-{launcherStartTicks}.jsonl");
            void Record(object value) => File.AppendAllText(journal, JsonSerializer.Serialize(value) + "\n");
            Record(new { phase="native-start", launchNonce, launcherPid=Environment.ProcessId, launcherStartUtc=own.StartTime.ToUniversalTime(),
                launcherStartTicks,
                launcherPath=Environment.ProcessPath, cwd=Directory.GetCurrentDirectory(), args, configSHA256=Hash(configPath), synthetic=true });
            if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("codex-cli 0.0.0-fixture"); return 0; }
            var info = new ProcessStartInfo { FileName=node, WorkingDirectory=Directory.GetCurrentDirectory(),
                UseShellExecute=false, CreateNoWindow=true, RedirectStandardInput=true, RedirectStandardOutput=true, RedirectStandardError=true };
            info.ArgumentList.Add(script);
            foreach (string arg in args) info.ArgumentList.Add(arg);
            // Fixture correlation only; never a product IPC or authentication value.
            info.Environment["REVIEWOPS_FIXTURE_LAUNCH_NONCE"] = launchNonce;
            using Process child = Process.Start(info) ?? throw new InvalidOperationException("Fixture child did not start");
            string nodeStartTicks = child.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
            Record(new { phase="node-child-start", launchNonce, launcherPid=Environment.ProcessId, launcherStartTicks, nodeChildPid=child.Id,
                nodeStartUtc=child.StartTime.ToUniversalTime(), nodeStartTicks,
                nodeExecutable=node, nodeSHA256=cfg.nodeSHA256,
                agentScript=script, agentSHA256=cfg.agentSHA256, cwd=info.WorkingDirectory, args,
                stdio="redirected unchanged byte streams; stdin payload is not logged" });
            using var inputCancelled = new CancellationTokenSource();
            async Task ForwardInput() {
                try { await Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream, inputCancelled.Token); }
                catch (OperationCanceledException) { } catch (IOException) { }
                finally { try { child.StandardInput.Close(); } catch (InvalidOperationException) { } }
            }
            Task input = ForwardInput();
            Task stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            Task stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            await child.WaitForExitAsync();
            inputCancelled.Cancel();
            await Task.WhenAll(stdout, stderr);
            Record(new { phase="node-child-exit", launchNonce, launcherPid=Environment.ProcessId, launcherStartTicks, nodeChildPid=child.Id, nodeStartTicks, exitCode=child.ExitCode });
            // Do not signal or kill a PID here. Product agent.cancel owns its
            // retained CLI process tree. Abrupt Windows cancellation may prevent
            // this log line; verify exact recorded identities read-only after it.
            return child.ExitCode;
        } catch (Exception error) {
            Console.Error.WriteLine("Synthetic native fixture failed: " + error.GetType().Name);
            return 84;
        }
    }
}
