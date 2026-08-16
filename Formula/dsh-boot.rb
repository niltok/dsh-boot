# dsh-boot Homebrew formula.
#
# The URL owner/sha256 pair is maintained per release. Build the macOS
# artifacts locally (or wait for the GitHub release) and run:
#   node scripts/update-brew-formula.mjs <github-owner> <version>
# The script prefers dist/*.tar.gz and falls back to the published release.
class DshBoot < Formula
  desc "Lightweight launcher for the DeepSeek Harness (dsh) web service"
  homepage "https://github.com/YOUR_GITHUB_OWNER/dsh-boot"
  version "0.1.0"
  license "MIT"

  on_arm do
    url "https://github.com/YOUR_GITHUB_OWNER/dsh-boot/releases/download/v#{version}/dsh-boot-#{version}-darwin-arm64.tar.gz"
    sha256 "REPLACE_WITH_ARM64_SHA256"
  end

  on_intel do
    url "https://github.com/YOUR_GITHUB_OWNER/dsh-boot/releases/download/v#{version}/dsh-boot-#{version}-darwin-x64.tar.gz"
    sha256 "REPLACE_WITH_X64_SHA256"
  end

  def install
    # The archive has a self-contained root: node/, node_modules/, lib/, bin/.
    libexec.install Dir["*"]
    libexec.install ".dsh-boot-install" if File.exist?(".dsh-boot-install")

    # The bundled bin wrappers resolve symlinks before locating their install
    # root, so Homebrew symlinks work without patching them.
    bin.install_symlink libexec/"bin/dsh-boot"
    bin.install_symlink libexec/"bin/dsh"
    bin.install_symlink libexec/"bin/pnpm"
  end

  service do
    run [opt_bin/"dsh-boot", "run"]
    run_type :immediate
    keep_alive false
    require_root false
    log_path var/"log/dsh-boot.log"
    error_log_path var/"log/dsh-boot.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/dsh-boot --version").strip
  end
end
