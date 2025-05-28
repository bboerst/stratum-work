output "instance_name" {
  description = "The name of the created GCE instance."
  value       = google_compute_instance.collector_vm.name
}

output "instance_public_ip" {
  description = "The public IP address of the GCE instance. This is an ephemeral IP."
  value       = google_compute_instance.collector_vm.network_interface[0].access_config[0].nat_ip
}

output "instance_network_tags" {
  description = "Network tags applied to the GCE instance."
  value       = google_compute_instance.collector_vm.tags
}

output "firewall_rule_name" {
  description = "The name of the firewall rule created for the collector."
  value       = google_compute_firewall.allow_collector_tcp.name
} 