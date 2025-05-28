variable "gcp_project_id" {
  description = "The GCP project ID to use."
  type        = string
  # No default, should be set in terraform.tfvars or via environment variables
}

variable "gcp_region" {
  description = "The default GCP region (e.g., us-east1)."
  type        = string
  default     = "us-east1"
}

variable "firewall_source_ranges" {
  description = "A list of CIDR IPv4 ranges that are allowed to access the collector ports."
  type        = list(string)
  # No default here, will be set in terraform.tfvars
  # Example: ["YOUR_HOME_IP_CIDR", "YOUR_OFFICE_IP_CIDR"]
}

variable "collector_sensitive_args" {
  description = "A map of sensitive arguments for collectors, keyed by pool_name. Each value is a list of strings (arguments)."
  type        = map(list(string))
  default     = {}
  sensitive   = true # Marks the variable's value as sensitive in Terraform UI output
}

# You might want to add more global variables here if needed. 