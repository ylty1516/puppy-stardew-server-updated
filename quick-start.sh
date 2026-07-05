#!/bin/bash
# =============================================================================
# Puppy Stardew Server - Quick Start Script
# 小狗星谷服务器 - 快速启动脚本
# =============================================================================
# This script will help you set up a Stardew Valley dedicated server in minutes!
# 此脚本将帮助您在几分钟内设置星露谷物语专用服务器！
# =============================================================================

# Don't exit on error - we handle errors manually
set +e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# =============================================================================
# Helper Functions
# =============================================================================

print_header() {
    echo ""
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}${BOLD}  🐶 Puppy Stardew Server - Quick Start${NC}"
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_step() {
    echo ""
    echo -e "${BOLD}$1${NC}"
}

ask_question() {
    echo -e "${CYAN}❓ $1${NC}"
}

set_env_value() {
    env_key="$1"
    env_value="$2"
    env_file="${3:-.env}"
    env_tmp="${env_file}.tmp.$$"

    PUPPY_ENV_KEY="$env_key" PUPPY_ENV_VALUE="$env_value" awk '
        BEGIN {
            key = ENVIRON["PUPPY_ENV_KEY"];
            value = ENVIRON["PUPPY_ENV_VALUE"];
            done = 0;
        }
        index($0, key "=") == 1 {
            print key "=" value;
            done = 1;
            next;
        }
        { print }
        END {
            if (!done) {
                print key "=" value;
            }
        }
    ' "$env_file" > "$env_tmp" && mv "$env_tmp" "$env_file"
}

print_compose_failure_help() {
    compose_log="$1"
    project_path="$(pwd)"

    echo ""
    print_error "Docker Compose failed. Key troubleshooting info follows."
    echo ""

    if grep -Eiq 'registry-1\.docker\.io|docker\.io/library|i/o timeout|failed to resolve source metadata|failed to do request' "$compose_log"; then
        print_warning "Docker Hub base image pull timed out."
        echo "This is usually a server network problem reaching Docker Hub, not a Stardew server crash."
        echo ""
        echo "Retry from the project directory:"
        echo -e "  ${CYAN}cd \"$project_path\"${NC}"
        echo -e "  ${CYAN}$COMPOSE_CMD up -d --build${NC}"
        echo ""
        echo "If your server provider has a Docker Hub mirror, set these in .env and retry:"
        echo -e "  ${CYAN}MANAGER_BASE_IMAGE=your-mirror.example.com/docker:27-cli${NC}"
        echo -e "  ${CYAN}SERVER_BASE_IMAGE=your-mirror.example.com/ubuntu:22.04${NC}"
        echo -e "  ${CYAN}$COMPOSE_CMD up -d --build${NC}"
        echo ""
    fi

    echo "Run logs from the project directory, otherwise Docker will print no configuration file provided:"
    echo -e "  ${CYAN}cd \"$project_path\"${NC}"
    echo -e "  ${CYAN}$COMPOSE_CMD logs --tail=120${NC}"
    echo ""
    echo "Last startup output:"
    tail -n 30 "$compose_log" 2>/dev/null || true
}

# Docker Compose command (global variable, set in check_docker)
COMPOSE_CMD=""
REPO_URL="https://github.com/ylty1516/puppy-stardew-server-updated.git"
REPO_DIR="puppy-stardew-server-updated"
RAW_BASE_URL="https://raw.githubusercontent.com/ylty1516/puppy-stardew-server-updated/main"

# =============================================================================
# Main Setup Functions
# =============================================================================

check_docker() {
    print_step "Step 1: Checking Docker installation..."

    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed!"
        echo ""
        echo "Please run the following command to install Docker:"
        echo -e "  ${CYAN}curl -fsSL https://get.docker.com | sh${NC}"
        echo ""
        echo "Other systems: https://docs.docker.com/get-docker/"
        echo ""
        exit 1
    fi

    if ! docker ps &> /dev/null; then
        print_error "Docker daemon is not running or requires sudo!"
        echo ""
        echo "Try one of these:"
        echo -e "  1. Start Docker: ${CYAN}sudo systemctl start docker${NC}"
        echo -e "  2. Add your user to docker group: ${CYAN}sudo usermod -aG docker \$USER${NC}"
        echo "     (Then log out and back in)"
        echo ""
        exit 1
    fi

    # Detect Docker Compose availability
    if docker compose version &> /dev/null; then
        COMPOSE_CMD="docker compose"
        print_success "Docker is installed and running! (Docker Compose v2)"
    elif command -v docker-compose &> /dev/null; then
        COMPOSE_CMD="docker-compose"
        print_success "Docker is installed and running! (Docker Compose v1)"
    else
        # Try to auto-install docker-compose-plugin
        print_warning "Docker Compose not found, attempting auto-install..."
        echo ""

        INSTALL_SUCCESS=false

        # Method 1: apt (Ubuntu/Debian)
        if command -v apt-get &> /dev/null; then
            print_info "Detected apt package manager, installing docker-compose-plugin..."
            if apt-get update -qq &> /dev/null && apt-get install -y -qq docker-compose-plugin &> /dev/null; then
                INSTALL_SUCCESS=true
            fi
        fi

        # Method 2: yum (CentOS/RHEL)
        if [ "$INSTALL_SUCCESS" = "false" ] && command -v yum &> /dev/null; then
            print_info "Detected yum package manager, installing docker-compose-plugin..."
            if yum install -y docker-compose-plugin &> /dev/null; then
                INSTALL_SUCCESS=true
            fi
        fi

        # Method 3: dnf (Fedora)
        if [ "$INSTALL_SUCCESS" = "false" ] && command -v dnf &> /dev/null; then
            print_info "Detected dnf package manager, installing docker-compose-plugin..."
            if dnf install -y docker-compose-plugin &> /dev/null; then
                INSTALL_SUCCESS=true
            fi
        fi

        # Verify installation result
        if [ "$INSTALL_SUCCESS" = "true" ] && docker compose version &> /dev/null; then
            COMPOSE_CMD="docker compose"
            print_success "Docker Compose auto-installed successfully!"
        else
            # Auto-install failed, provide specific manual install command
            print_error "Docker Compose auto-install failed!"
            echo ""
            print_info "Please run the following command to install manually:"
            echo ""
            if command -v apt-get &> /dev/null; then
                echo -e "  ${CYAN}sudo apt-get update && sudo apt-get install -y docker-compose-plugin${NC}"
            elif command -v yum &> /dev/null; then
                echo -e "  ${CYAN}sudo yum install -y docker-compose-plugin${NC}"
            else
                echo -e "  ${CYAN}sudo apt-get update && sudo apt-get install -y docker-compose-plugin${NC}"
            fi
            echo ""
            echo "After installation, re-run this script."
            echo ""
            exit 1
        fi
    fi
}

download_files() {
    print_step "Step 2: Downloading configuration files..."

    # Check if we're already in the repo
    if [ -f "docker-compose.yml" ] && [ -f ".env.example" ]; then
        print_success "Configuration files found!"
        return
    fi

    # Try to clone the repository
    if command -v git &> /dev/null; then
        print_info "Cloning repository..."
        git clone "$REPO_URL" "$REPO_DIR"
        cd "$REPO_DIR" || exit 1
        print_success "Repository cloned!"
    else
        # Download files individually
        print_info "Git not found, downloading files individually..."

        if ! command -v wget &> /dev/null && ! command -v curl &> /dev/null; then
            print_error "Neither wget nor curl found!"
            echo "Please install git, wget, or curl to continue."
            exit 1
        fi

        mkdir -p "$REPO_DIR"
        cd "$REPO_DIR" || exit 1

        if command -v curl &> /dev/null; then
            curl -fsSL "$RAW_BASE_URL/docker-compose.yml" -o docker-compose.yml
            curl -fsSL "$RAW_BASE_URL/.env.example" -o .env.example
        else
            wget -q "$RAW_BASE_URL/docker-compose.yml" -O docker-compose.yml
            wget -q "$RAW_BASE_URL/.env.example" -O .env.example
        fi

        print_success "Files downloaded!"
    fi
}

configure_steam() {
    print_step "Step 3: Steam configuration..."

    echo ""
    print_warning "IMPORTANT: You MUST own Stardew Valley on Steam!"
    print_info "Game files will be downloaded via your Steam account."
    echo ""

    # Check if .env already exists
    if [ -f ".env" ]; then
        ask_question ".env file already exists. Do you want to reconfigure? (y/n)"
        read -r reconfigure </dev/tty
        if [[ ! $reconfigure =~ ^[Yy]$ ]]; then
            print_info "Using existing .env file"
            return
        fi
    fi

    # Copy .env.example to .env
    cp .env.example .env

    echo ""
    print_info "═══════════════════════════════════════════════════"
    print_info "  Configuration Method"
    print_info "═══════════════════════════════════════════════════"
    echo ""
    ask_question "Do you want to manually input configuration in terminal? (y/n)"
    echo -e "${CYAN}  y${NC} - Input Steam username, password and VNC password now"
    echo -e "${CYAN}  n${NC} - Manually edit .env file later (recommended for Linux experts)"
    echo ""
    read -r manual_input </dev/tty

    if [[ $manual_input =~ ^[Yy]$ ]]; then
        # Manual input mode
        echo ""
        ask_question "Enter your Steam username:"
        read -r steam_username </dev/tty

        echo ""
        ask_question "Enter your Steam password (input hidden):"
        read -rs steam_password </dev/tty
        echo ""

        # Validate inputs
        if [ -z "$steam_username" ] || [ -z "$steam_password" ]; then
            print_error "Steam username and password cannot be empty!"
            exit 1
        fi

        echo ""
        print_info "If you have Steam Guard enabled, you'll need to enter a code later."
        print_info "Consider using the Steam Guard mobile app for faster codes."

        echo ""
        ask_question "Enter VNC password (max 8 chars, press Enter to auto-generate a random one):"
        read -r vnc_password </dev/tty
        if [ -z "$vnc_password" ]; then
            vnc_password="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 8)"
            print_info "Generated a random VNC password: ${vnc_password}"
            print_info "Save it now — you'll need it to connect via VNC."
        fi

        # Validate and truncate VNC password to 8 characters
        if [ ${#vnc_password} -gt 8 ]; then
            print_warning "VNC password is longer than 8 characters!"
            print_warning "VNC protocol will truncate it to 8 characters."
            vnc_password="${vnc_password:0:8}"
        fi

        # Update .env file. Avoid sed substitution because Steam passwords can
        # contain /, \, or &, which break sed expressions.
        if set_env_value "STEAM_USERNAME" "$steam_username" .env \
            && set_env_value "STEAM_PASSWORD" "$steam_password" .env \
            && set_env_value "VNC_PASSWORD" "$vnc_password" .env; then
            print_success "Steam credentials configured!"
        else
            print_error "Failed to write .env. Check the current directory permissions."
            exit 1
        fi
    else
        # Manual .env editing mode
        echo ""
        print_info "Please manually edit the .env file to configure your credentials:"
        echo -e "  ${CYAN}nano .env${NC}  or  ${CYAN}vim .env${NC}"
        echo ""
        print_info "You need to configure the following fields:"
        echo -e "  ${YELLOW}STEAM_USERNAME${NC}  - Your Steam username"
        echo -e "  ${YELLOW}STEAM_PASSWORD${NC}  - Your Steam password"
        echo -e "  ${YELLOW}VNC_PASSWORD${NC}    - VNC access password (max 8 characters)"
        echo ""
        ask_question "Press Enter to continue after configuration..."
        read -r </dev/tty
    fi
}

setup_directories() {
    print_step "Step 4: Setting up data directories..."

    # Create directories (including logs for log monitoring)
    mkdir -p data/{saves,game,steam,logs,backups,custom-mods,panel,meta,secrets}

    # Fix permissions (UID 1000 is the steam user in the container)
    print_info "Setting correct permissions (UID 1000)..."

    # Check if we need sudo
    if [ -w "data" ]; then
        chown -R 1000:1000 data/
    else
        print_info "Need sudo to set permissions..."
        sudo chown -R 1000:1000 data/
    fi

    # Verify permissions were set correctly
    if [ "$(stat -c '%u' data/game 2>/dev/null || stat -f '%u' data/game 2>/dev/null)" != "1000" ]; then
        print_error "Failed to set correct permissions!"
        print_error "This will cause 'Disk write failure' when downloading game files."
        echo ""
        echo "Please run: sudo chown -R 1000:1000 data/"
        echo ""
        exit 1
    fi

    print_success "Directories created and permissions set!"
}

start_server() {
    print_step "Step 5: Starting the server..."

    echo ""
    if [ "${PUPPY_COMPOSE_PULL:-false}" = "true" ]; then
        print_info "Pulling Docker image (this may take a few minutes)..."
        $COMPOSE_CMD pull || print_warning "Image pull failed, continuing with local build..."
    else
        print_info "Skipping docker compose pull: this project builds local images by default, which avoids a slow unnecessary pull."
    fi

    echo ""
    print_info "Starting server..."
    compose_log="$(mktemp)"
    $COMPOSE_CMD up -d 2>&1 | tee "$compose_log"
    compose_status=${PIPESTATUS[0]}
    if [ "$compose_status" -eq 0 ]; then
        rm -f "$compose_log"
        print_success "Server started!"
    else
        print_compose_failure_help "$compose_log"
        rm -f "$compose_log"
        exit 1
    fi

    # Wait for init container to complete
    print_info "Waiting for init container to complete..."
    for i in {1..30}; do
        INIT_STATUS=$(docker inspect --format='{{.State.Status}}' puppy-stardew-init 2>/dev/null)
        if [ "$INIT_STATUS" = "exited" ]; then
            INIT_EXIT=$(docker inspect --format='{{.State.ExitCode}}' puppy-stardew-init 2>/dev/null)
            if [ "$INIT_EXIT" = "0" ]; then
                print_success "Init container completed successfully!"
                break
            else
                print_error "Init container failed (exit code: $INIT_EXIT)!"
                echo "Check logs: docker logs puppy-stardew-init"
                exit 1
            fi
        fi
        sleep 1
    done

    echo ""
    print_info "Waiting for server to initialize (5 seconds)..."
    sleep 5

    # Check if container is running
    if ! docker ps | grep -q puppy-stardew; then
        print_error "Container failed to start!"
        echo ""
        echo "Check logs with: docker logs puppy-stardew"
        exit 1
    fi

    print_success "Server is running!"
}

show_next_steps() {
    print_step "🎉 Setup Complete! Here's what to do next:"

    echo ""
    echo -e "${BOLD}1. Monitor the download progress:${NC}"
    echo "   docker logs -f puppy-stardew"
    echo ""
    echo -e "${YELLOW}   The first startup will download ~1.5GB game files.${NC}"
    echo -e "${YELLOW}   This usually takes 5-15 minutes depending on your internet speed.${NC}"
    echo ""

    echo -e "${BOLD}2. If Steam Guard is enabled:${NC}"
    echo "   - Check logs for Steam Guard prompt:"
    echo -e "     ${CYAN}docker logs puppy-stardew | grep -i \"steam guard\"${NC}"
    echo "   - If you see \"Steam Guard code:\" prompt, attach to the container:"
    echo -e "     ${CYAN}docker attach puppy-stardew${NC}"
    echo "   - Enter your Steam Guard code from email/mobile app and press Enter"
    echo -e "   - ${YELLOW}Important:${NC} Wait 3-5 seconds after entering to confirm game download starts"
    echo -e "   - Then press ${YELLOW}Ctrl+P Ctrl+Q${NC} to detach (${RED}NOT Ctrl+C!${NC})"
    echo ""

    echo -e "${BOLD}3. 🌐 Web Management Panel (Recommended):${NC}"
    echo -e "   - Browser access: ${CYAN}http://$(get_server_ip):18642${NC}"
    echo "   - First visit: create your admin password in the setup page"
    echo "   - Features: real-time status, logs, terminal, config, saves, mods"
    echo ""

    echo -e "${BOLD}4. Optional VNC setup (only if you want manual in-game setup):${NC}"
    echo "   - Download a VNC client (RealVNC, TightVNC, etc.)"
    echo -e "   - Connect to: ${CYAN}$(get_server_ip):5900${NC}"
    _vnc_pw="$(grep '^VNC_PASSWORD=' .env 2>/dev/null | cut -d'=' -f2)"
    if [ -n "$_vnc_pw" ]; then
        echo -e "   - Password: ${CYAN}${_vnc_pw}${NC}"
    else
        echo -e "   - Password: ${CYAN}auto-generated at startup${NC} (retrieve with: docker exec <container> cat /home/steam/web-panel/data/vnc_password.txt)"
    fi
    echo "   - Use this if you want to create a new save manually in-game"
    echo "   - Or upload an existing save through the web panel and set it as default"
    echo ""

    echo -e "${BOLD}5. Players can connect:${NC}"
    echo "   - Open Stardew Valley"
    echo "   - Click \"Co-op\" → \"Join LAN Game\""
    echo "   - Server will appear automatically, or enter server IP manually"
    echo -e "   ${YELLOW}⚠️  Note: Only IP needed, port 24642 is used by default${NC}"
    echo ""

    echo -e "${BOLD}Useful commands:${NC}"
    echo -e "   View logs:        ${CYAN}docker logs -f puppy-stardew${NC}"
    echo -e "   Restart server:   ${CYAN}$COMPOSE_CMD down && $COMPOSE_CMD up -d${NC}"
    echo -e "   Stop server:      ${CYAN}$COMPOSE_CMD down${NC}"
    echo -e "   Check health:     ${CYAN}./health-check.sh${NC}"
    echo -e "   Verify deploy:    ${CYAN}./verify-deployment.sh${NC}"
    echo -e "   Backup saves:     ${CYAN}./backup.sh${NC}"
    echo ""
    echo -e "${YELLOW}   ⚠️  Note: After modifying .env, you must restart for changes to take effect!${NC}"
    echo ""

    echo -e "${GREEN}${BOLD}🌟 Enjoy your instant-sleep Stardew Valley server!${NC}"
    echo ""

    # Smart detection of Steam Guard requirement
    echo ""
    print_info "Detecting server status..."
    sleep 2

    NEEDS_STEAM_GUARD=false
    RECENT_LOGS=$(docker logs --tail 50 puppy-stardew 2>&1 || true)
    if echo "$RECENT_LOGS" | grep -qi "steam guard\|two-factor\|two factor\|auth code\|verification code\|Enter the current code"; then
        NEEDS_STEAM_GUARD=true
    fi

    if [ "$NEEDS_STEAM_GUARD" = "true" ]; then
        echo ""
        print_warning "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        print_warning "  Steam Guard verification code required!"
        print_warning "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        print_info "You need to attach to the container to enter the Steam Guard code."
        print_info "Follow these steps:"
        echo ""
        echo -e "  ${CYAN}1.${NC} Run: ${CYAN}docker attach puppy-stardew${NC}"
        echo -e "  ${CYAN}2.${NC} Enter the code from your email/mobile app and press Enter"
        echo -e "  ${CYAN}3.${NC} Wait 3-5 seconds to confirm game download starts"
        echo -e "  ${CYAN}4.${NC} Press ${YELLOW}Ctrl+P Ctrl+Q${NC} to detach (${RED}NOT Ctrl+C!${NC})"
        echo ""
    else
        echo ""
        ask_question "What would you like to do next?"
        echo -e "  ${CYAN}1${NC} - View live logs: ${CYAN}docker logs -f puppy-stardew${NC}"
        echo -e "  ${CYAN}2${NC} - Attach to container (for entering verification code): ${CYAN}docker attach puppy-stardew${NC}"
        echo ""
        print_info "You can copy and run the commands above in your terminal."
    fi
}

get_server_ip() {
    # Try to get public IP
    if command -v curl &> /dev/null; then
        public_ip=$(curl -4 -s ifconfig.me 2>/dev/null || curl -4 -s ip.sb 2>/dev/null || echo "")
        if [ -n "$public_ip" ]; then
            echo "$public_ip"
            return
        fi
    fi

    # Fall back to local IP
    if command -v hostname &> /dev/null; then
        hostname -I 2>/dev/null | awk '{print $1}' || echo "your-server-ip"
    else
        echo "your-server-ip"
    fi
}

# =============================================================================
# Main Script
# =============================================================================

main() {
    print_header

    check_docker
    download_files
    configure_steam
    setup_directories
    start_server
    show_next_steps
}

# Run main function
main
