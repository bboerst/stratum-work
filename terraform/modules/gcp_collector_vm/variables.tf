variable "project_id" {
  description = "The GCP project ID to deploy resources in."
  type        = string
}

variable "zone" {
  description = "The GCP zone to deploy the VM in (e.g., us-east1-b)."
  type        = string
  default     = "us-east1-b"
}

variable "vm_identifier" {
  description = "A unique identifier for this VM, used for naming resources (e.g., 'us-east-collectors-1')."
  type        = string
}

variable "instance_name_prefix" {
  description = "A prefix for the VM instance name. The vm_identifier and a random suffix will be appended."
  type        = string
  default     = "collector-vm"
}

variable "machine_type" {
  description = "The machine type for the VM instance."
  type        = string
  default     = "e2-micro"
}

variable "boot_disk_image" {
  description = "The image to use for the boot disk, e.g., 'debian-cloud/debian-11'."
  type        = string
  default     = "debian-cloud/debian-11"
}

variable "collectors_config" {
  description = "A list of collector configurations to run on this VM."
  type = list(object({
    pool_name   = string
    image_name  = string
    image_tag   = string
    stratum_port = string
    arguments   = optional(list(string), [])
  }))
  default = []
}

variable "tcp_ports_to_open" {
  description = "A list of TCP ports to open in the firewall for all collectors on this VM. This should include all stratum_port values from collectors_config."
  type        = list(string)
  default     = []
}

variable "subnetwork" {
  description = "The name or self_link of the subnetwork to attach the instance to."
  type        = string
  default     = ""
}

variable "network_tags" {
  description = "A list of network tags to apply to the instance. Useful for firewall rules defined outside this module."
  type        = list(string)
  default     = ["stratum-collector-vm"]
}

variable "service_account_email" {
  description = "The email of the service account to attach to the instance. If empty, the default compute service account is used."
  type        = string
  default     = ""
}

variable "firewall_source_ranges" {
  description = "A list of CIDR IPv4 ranges that are allowed to access the collector ports. Defaults to allowing all (0.0.0.0/0)."
  type        = list(string)
  default     = ["0.0.0.0/0"]
} 