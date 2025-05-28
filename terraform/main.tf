# This main.tf will call the gcp_collector_vm module.
# You can create multiple instances of the module here for different VMs,
# each VM running one or more collectors.

locals {
  # Example configuration for a VM in us-east1 that will run two collector instances
  us_east1_collectors = [
    {
      pool_name    = "Ocean Default",
      image_name   = "bboerst/stratum-work-collector",
      image_tag    = "v1.0.8pre24",
      stratum_port = "3333",
      # Non-sensitive arguments can be listed here, or an empty list if none
      base_arguments = ["--enable-stratum-client"] 
    },
    {
      pool_name    = "Ocean Core",
      image_name   = "bboerst/stratum-work-collector",
      image_tag    = "v1.0.8pre24",
      stratum_port = "3334",
      # Non-sensitive arguments can be listed here, or an empty list if none
      base_arguments = ["--enable-stratum-client"] 
    },
    {
      pool_name    = "Ocean Core+Antispam",
      image_name   = "bboerst/stratum-work-collector",
      image_tag    = "v1.0.8pre24",
      stratum_port = "3335",
      # Non-sensitive arguments can be listed here, or an empty list if none
      base_arguments = ["--enable-stratum-client"] 
    },
    {
      pool_name    = "Ocean Data-Free",
      image_name   = "bboerst/stratum-work-collector",
      image_tag    = "v1.0.8pre24",
      stratum_port = "3336",
      # Non-sensitive arguments can be listed here, or an empty list if none
      base_arguments = ["--enable-stratum-client"] 
    },
  ]

  # Combine base arguments with sensitive arguments from tfvars
  processed_us_east1_collectors = [
    for c in local.us_east1_collectors : {
      pool_name    = c.pool_name
      image_name   = c.image_name
      image_tag    = c.image_tag
      stratum_port = c.stratum_port
      arguments    = concat(c.base_arguments, lookup(var.collector_sensitive_args, c.pool_name, []))
    }
  ]

  # Example configuration for another VM, perhaps in a different region or for different pools
  # us_central1_collectors = [
  #   {
  #     pool_name    = "Pool_C_USCentral1",
  #     image_name   = "your-repo/other-collector-image",
  #     image_tag    = "stable",
  #     stratum_port = "4000",
  #     arguments    = []
  #   }
  # ]
}

module "us_east1_multi_collector_vm" {
  source = "./modules/gcp_collector_vm" 

  project_id             = var.gcp_project_id
  vm_identifier          = "use1-collectors-01" # Unique identifier for this VM
  zone                   = "us-east1-b"
  instance_name_prefix   = "multi-coll-vm"      # Prefix for the VM name
  machine_type           = "e2-medium"          # May need a larger VM for multiple collectors

  collectors_config      = local.processed_us_east1_collectors # Use the processed list
  # Dynamically create list of ports to open from the collectors_config
  tcp_ports_to_open      = [for c in local.processed_us_east1_collectors : c.stratum_port]
  firewall_source_ranges = var.firewall_source_ranges
  
  # network_tags = ["custom-tag-for-this-vm"]
  # service_account_email = "your-service-account@your-project-id.iam.gserviceaccount.com"
}

# Example for a second VM
# module "us_central1_multi_collector_vm" {
#   source = "./modules/gcp_collector_vm"
# 
#   project_id             = var.gcp_project_id
#   vm_identifier          = "usc1-collectors-01"
#   zone                   = "us-central1-a"
#   instance_name_prefix   = "multi-coll-vm"
#   machine_type           = "e2-small"
# 
#   collectors_config      = local.processed_us_central1_collectors # Use processed if defined
#   tcp_ports_to_open      = [for c in local.processed_us_central1_collectors : c.stratum_port]
#   firewall_source_ranges = var.firewall_source_ranges 
# }


output "us_east1_multi_collector_vm_public_ip" {
  description = "Public IP of the us-east1 multi-collector VM."
  value       = module.us_east1_multi_collector_vm.instance_public_ip
}

output "us_east1_multi_collector_vm_instance_name" {
  description = "Instance name of the us-east1 multi-collector VM."
  value       = module.us_east1_multi_collector_vm.instance_name
} 