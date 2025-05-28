terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      # You can pin to a specific version or use a range
      version = ">= 4.0.0"
    }
  }
}

# Configure the Google Cloud provider
provider "google" {
  # The project and region/zone can be set here, or through environment variables,
  # or passed via CLI arguments. For per-module flexibility, often project is passed as a variable.
  # If you have GOOGLE_PROJECT and GOOGLE_REGION/GOOGLE_ZONE env vars set, you might not need to specify them here.
  # project = var.gcp_project_id # Assumes you'll define gcp_project_id in variables.tf for this environment
  # region  = var.gcp_region     # Assumes you'll define gcp_region in variables.tf for this environment
} 