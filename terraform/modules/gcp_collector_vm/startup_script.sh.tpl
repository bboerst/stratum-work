#!/bin/bash
set -euxo pipefail # Exit on error, treat unset variables as an error, and print commands

# Install Podman and jq
apt-get update
apt-get install -y podman jq

# Podman system service setup (optional, but good for auto-starting containers on boot if desired via systemd units later)
# For now, we will just run the container directly. You can expand this to create a systemd service for the container.

# Define variables passed from Terraform
# COLLECTORS_CONFIG_JSON is a JSON string containing a list of collector objects
COLLECTORS_CONFIG_JSON='${collectors_config_json}' # This is the main Terraform interpolation

# Check if COLLECTORS_CONFIG_JSON is empty or not a valid JSON array
if ! echo "$COLLECTORS_CONFIG_JSON" | jq -e '. | length >= 0' > /dev/null 2>&1; then
  echo "No valid collector configurations provided. Exiting."
  exit 0
fi

# Loop through each collector configuration using jq
echo "$COLLECTORS_CONFIG_JSON" | jq -c '.[]' | while IFS= read -r collector_config; do
  POOL_NAME=$(echo "$collector_config" | jq -r '.pool_name')
  IMAGE_NAME=$(echo "$collector_config" | jq -r '.image_name')
  IMAGE_TAG=$(echo "$collector_config" | jq -r '.image_tag')
  STRATUM_PORT=$(echo "$collector_config" | jq -r '.stratum_port')
  ARGUMENTS_JSON=$(echo "$collector_config" | jq -r '.arguments // []')
  ARGUMENTS_STRING=$(echo "$ARGUMENTS_JSON" | jq -r '.[]' | tr '\n' ' ')

  echo "Processing collector for Pool: $$POOL_NAME"
  echo "  Image: $$IMAGE_NAME:$$IMAGE_TAG"
  echo "  Stratum Port (Host): $$STRATUM_PORT"
  echo "  Additional Arguments: $$ARGUMENTS_STRING"

  SANITIZED_POOL_NAME=$(echo "$$POOL_NAME" | sed 's/[^a-zA-Z0-9.-]/_/g' | tr '[:upper:]' '[:lower:]')
  CONTAINER_NAME="stratum-collector-$$SANITIZED_POOL_NAME"

  if podman inspect "$$CONTAINER_NAME" &>/dev/null; then
    echo "Stopping and removing existing container: $$CONTAINER_NAME"
    podman stop "$$CONTAINER_NAME" || true 
    podman rm "$$CONTAINER_NAME" || true   
  fi

  echo "Pulling image: $$IMAGE_NAME:$$IMAGE_TAG"
  podman pull "$$IMAGE_NAME:$$IMAGE_TAG"

  CMD=(
    podman run -d --name "$$CONTAINER_NAME" \
    --network=host \
    --env POOL_NAME="$$POOL_NAME" \
    --env STRATUM_PORT="$$STRATUM_PORT" \
    "$$IMAGE_NAME:$$IMAGE_TAG" \
    --pool-name "$$POOL_NAME" \
  )
  
  if [[ -n "$$ARGUMENTS_STRING" ]]; then
    read -r -a EXTRA_ARGS <<< "$$ARGUMENTS_STRING"
    CMD+=("$${EXTRA_ARGS[@]}") # Escaped here
  fi

  echo "Starting container $$CONTAINER_NAME with command: $${CMD[@]}" # Escaped here
  "$${CMD[@]}" # Escaped here

  echo "Collector container '$$CONTAINER_NAME' for pool '$$POOL_NAME' scheduled to start on host port '$$STRATUM_PORT'."
  echo "-----------------------------------------------------"
done

echo "All configured collectors processed."

# Note on networking: 
# Using --network=host simplifies things as the container shares the host's network stack.
# This means if your collector listens on port 8000 internally, and you've opened port 3333 on the host's firewall,
# you'd typically map -p $STRATUM_PORT:$CONTAINER_INTERNAL_PORT.
# With --network=host, if the collector listens on port $STRATUM_PORT, it will be directly accessible on the host's IP at $STRATUM_PORT.
# Ensure your collector application inside the container is configured to listen on the desired port (e.g., the value of $STRATUM_PORT or a fixed port).
# For simplicity in this script and to avoid complex port mapping logic within the script for now, 
# we are assuming the collector app inside the container can be configured to listen on the desired external $STRATUM_PORT.
# If not, you would remove --network=host and add specific port mappings like -p $STRATUM_PORT:$CONTAINER_INTERNAL_APPLICATION_PORT.

# If your application inside the container *must* listen on a fixed port (e.g. 8000) and you want it exposed
# via the host's $STRATUM_PORT, you would do:
# podman run -d --name "$CONTAINER_NAME" \
#   -p "$STRATUM_PORT:$CONTAINER_INTERNAL_PORT" \
#   --env POOL_NAME="$POOL_NAME" \
#   "$COLLECTOR_IMAGE_NAME:$COLLECTOR_IMAGE_TAG" \
#   --pool-name "$POOL_NAME"

# For now, assuming the collector runs on the port specified by --stratum-port argument to the collector itself,
# and it's using host networking. The firewall rules on the VM will control external access to this port.

# If you want to pass all tcp_ports_to_open to the container as an argument or env var, you'd need to format it here.
# For example, if your app takes --ports "port1,port2":
# puertos_csv=$(IFS=,; echo "$${tcp_ports_to_open[*]}")
# ... add --ports "$puertos_csv" to podman run arguments

# The current helm chart passes arguments like:
# arguments:
#   - --pool-name
#   - {{ .poolName }}
# {{- range .arguments }}
#   - {{ . }}
# {{- end }}
# This script currently only explicitly adds --pool-name. You may need to extend this script 
# or modify the terraform to pass through more arguments if your collector needs them. 