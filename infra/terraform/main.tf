# ─── AEGIS GLOBAL — Terraform Infrastructure ─────────────────────────────────
# Provisions AWS + Azure + GCP across 9 regions

terraform {
  required_version = ">= 1.8.0"
  required_providers {
    aws   = { source = "hashicorp/aws",   version = "~> 5.50" }
    azurerm= { source = "hashicorp/azurerm",version = "~> 3.100" }
    google= { source = "hashicorp/google", version = "~> 5.30" }
    helm  = { source = "hashicorp/helm",  version = "~> 2.13" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.30" }
  }
  backend "s3" {
    bucket         = "aegis-terraform-state"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "aegis-terraform-lock"
  }
}

# ─── Variables ────────────────────────────────────────────────────────────────
variable "environment"      { default = "production" }
variable "aws_regions"      { default = ["us-east-1", "eu-west-1", "ap-south-1"] }
variable "azure_locations"  { default = ["eastus", "westeurope", "southeastasia"] }
variable "gcp_regions"      { default = ["us-central1", "europe-west1", "asia-east1"] }
variable "project_id"       { description = "GCP project ID" }
variable "cluster_version"  { default = "1.30" }
variable "node_instance_type" { default = "m6i.2xlarge" }
variable "min_nodes"        { default = 3 }
variable "max_nodes"        { default = 50 }

# ─── AWS Provider (primary) ───────────────────────────────────────────────────
provider "aws" {
  region = "us-east-1"
  alias  = "primary"
  default_tags {
    tags = {
      Project     = "aegis-global"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

provider "aws" {
  region = "eu-west-1"
  alias  = "eu"
}

provider "aws" {
  region = "ap-south-1"
  alias  = "ap"
}

# ─── Azure Provider ───────────────────────────────────────────────────────────
provider "azurerm" {
  features {}
}

# ─── GCP Provider ────────────────────────────────────────────────────────────
provider "google" {
  project = var.project_id
  region  = "us-central1"
}

# ─── AWS VPC ─────────────────────────────────────────────────────────────────
module "vpc_primary" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"
  providers = { aws = aws.primary }

  name = "aegis-vpc-primary"
  cidr = "10.0.0.0/16"

  azs              = ["us-east-1a", "us-east-1b", "us-east-1c"]
  private_subnets  = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets   = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]
  database_subnets = ["10.0.201.0/24", "10.0.202.0/24", "10.0.203.0/24"]

  enable_nat_gateway      = true
  single_nat_gateway      = false
  one_nat_gateway_per_az  = true
  enable_vpn_gateway      = false
  enable_dns_hostnames    = true
  enable_dns_support      = true

  tags = { Name = "aegis-vpc-primary", Tier = "network" }
}

# ─── EKS Cluster (Primary — us-east-1) ───────────────────────────────────────
module "eks_primary" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"
  providers = { aws = aws.primary }

  cluster_name    = "aegis-prod-primary"
  cluster_version = var.cluster_version
  vpc_id          = module.vpc_primary.vpc_id
  subnet_ids      = module.vpc_primary.private_subnets

  cluster_endpoint_public_access  = false
  cluster_endpoint_private_access = true

  enable_irsa = true

  eks_managed_node_groups = {
    general = {
      name           = "aegis-general"
      instance_types = [var.node_instance_type]
      min_size       = var.min_nodes
      max_size       = var.max_nodes
      desired_size   = 10
      disk_size      = 100

      labels = { role = "general", environment = var.environment }
      taints = {}

      update_config = {
        max_unavailable_percentage = 20
      }
    }

    ml_inference = {
      name           = "aegis-ml"
      instance_types = ["g4dn.xlarge"]
      min_size       = 2
      max_size       = 10
      desired_size   = 3
      disk_size      = 200
      ami_type       = "AL2_x86_64_GPU"
      labels         = { role = "ml-inference", accelerator = "gpu" }
    }
  }

  tags = { Name = "aegis-eks-primary", Region = "us-east-1" }
}

# ─── RDS PostgreSQL with PostGIS ──────────────────────────────────────────────
resource "aws_db_subnet_group" "primary" {
  name       = "aegis-db-subnet-primary"
  subnet_ids = module.vpc_primary.database_subnets
  provider   = aws.primary
}

resource "aws_rds_cluster" "primary" {
  provider                  = aws.primary
  cluster_identifier        = "aegis-postgres-primary"
  engine                    = "aurora-postgresql"
  engine_version            = "16.2"
  database_name             = "aegis_core"
  master_username           = "aegis_admin"
  manage_master_user_password = true
  db_subnet_group_name      = aws_db_subnet_group.primary.name
  backup_retention_period   = 35
  preferred_backup_window   = "02:00-03:00"
  deletion_protection       = true
  storage_encrypted         = true
  copy_tags_to_snapshot     = true
  enable_global_write_forwarding = true

  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = { Name = "aegis-aurora-primary", Engine = "postgresql" }
}

resource "aws_rds_cluster_instance" "primary" {
  count              = 3
  provider           = aws.primary
  identifier         = "aegis-postgres-primary-${count.index}"
  cluster_identifier = aws_rds_cluster.primary.id
  instance_class     = "db.r6g.2xlarge"
  engine             = aws_rds_cluster.primary.engine
  engine_version     = aws_rds_cluster.primary.engine_version
  publicly_accessible= false
  performance_insights_enabled = true
}

# ─── ElastiCache Redis Cluster ────────────────────────────────────────────────
resource "aws_elasticache_replication_group" "primary" {
  provider                   = aws.primary
  replication_group_id       = "aegis-redis-primary"
  description                = "AEGIS Redis cluster — primary region"
  node_type                  = "cache.r7g.large"
  num_cache_clusters         = 3
  parameter_group_name       = "default.redis7"
  engine_version             = "7.1"
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.primary.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = aws_secretsmanager_secret_version.redis_password.secret_string
  automatic_failover_enabled = true
  multi_az_enabled           = true

  tags = { Name = "aegis-redis-primary" }
}

resource "aws_elasticache_subnet_group" "primary" {
  provider   = aws.primary
  name       = "aegis-redis-subnet"
  subnet_ids = module.vpc_primary.private_subnets
}

resource "aws_security_group" "redis" {
  provider    = aws.primary
  name        = "aegis-redis-sg"
  description = "Security group for AEGIS Redis"
  vpc_id      = module.vpc_primary.vpc_id

  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [module.vpc_primary.vpc_cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ─── MSK Kafka Cluster ────────────────────────────────────────────────────────
resource "aws_msk_cluster" "primary" {
  provider              = aws.primary
  cluster_name          = "aegis-kafka-primary"
  kafka_version         = "3.6.0"
  number_of_broker_nodes = 3

  broker_node_group_info {
    instance_type   = "kafka.m5.2xlarge"
    client_subnets  = module.vpc_primary.private_subnets
    storage_info {
      ebs_storage_info { volume_size = 1000 }
    }
    security_groups = [aws_security_group.kafka.id]
  }

  encryption_info {
    encryption_in_transit { client_broker = "TLS" }
    encryption_at_rest    { data_volume_kms_key_id = aws_kms_key.aegis.arn }
  }

  logging_info {
    broker_logs {
      cloudwatch_logs { enabled = true; log_group = "/aws/msk/aegis-primary" }
    }
  }

  tags = { Name = "aegis-kafka-primary" }
}

resource "aws_security_group" "kafka" {
  provider    = aws.primary
  name        = "aegis-kafka-sg"
  vpc_id      = module.vpc_primary.vpc_id

  ingress {
    from_port   = 9092
    to_port     = 9096
    protocol    = "tcp"
    cidr_blocks = [module.vpc_primary.vpc_cidr_block]
  }
}

# ─── KMS Key ─────────────────────────────────────────────────────────────────
resource "aws_kms_key" "aegis" {
  provider                 = aws.primary
  description              = "AEGIS GLOBAL master encryption key"
  deletion_window_in_days  = 30
  enable_key_rotation      = true
  multi_region             = true
  tags                     = { Name = "aegis-master-key" }
}

resource "aws_kms_alias" "aegis" {
  provider      = aws.primary
  name          = "alias/aegis-master"
  target_key_id = aws_kms_key.aegis.key_id
}

# ─── Secrets Manager ──────────────────────────────────────────────────────────
resource "aws_secretsmanager_secret" "redis_password" {
  provider                = aws.primary
  name                    = "aegis/redis-password"
  recovery_window_in_days = 7
  kms_key_id              = aws_kms_key.aegis.arn
}

resource "aws_secretsmanager_secret_version" "redis_password" {
  provider      = aws.primary
  secret_id     = aws_secretsmanager_secret.redis_password.id
  secret_string = random_password.redis.result
}

resource "random_password" "redis" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "anthropic_api_key" {
  provider = aws.primary
  name     = "aegis/anthropic-api-key"
  kms_key_id = aws_kms_key.aegis.arn
}

# ─── CloudFront CDN ───────────────────────────────────────────────────────────
resource "aws_cloudfront_distribution" "frontend" {
  provider = aws.primary
  enabled  = true
  comment  = "AEGIS GLOBAL frontend CDN"

  origin {
    domain_name = "app.aegisglobal.io"
    origin_id   = "aegis-frontend-alb"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "aegis-frontend-alb"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
    min_ttl                = 0
    default_ttl            = 86400
    max_ttl                = 31536000

    forwarded_values {
      query_string = true
      cookies { forward = "none" }
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.aegis.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  price_class = "PriceClass_All"
  tags        = { Name = "aegis-cdn" }
}

resource "aws_acm_certificate" "aegis" {
  provider          = aws.primary
  domain_name       = "*.aegisglobal.io"
  validation_method = "DNS"

  subject_alternative_names = ["aegisglobal.io", "api.aegisglobal.io", "app.aegisglobal.io"]

  lifecycle { create_before_destroy = true }
}

# ─── Route 53 ────────────────────────────────────────────────────────────────
resource "aws_route53_zone" "primary" {
  provider = aws.primary
  name     = "aegisglobal.io"
}

resource "aws_route53_record" "api" {
  provider = aws.primary
  zone_id  = aws_route53_zone.primary.zone_id
  name     = "api.aegisglobal.io"
  type     = "A"
  alias {
    name                   = "dualstack.aegis-nlb-primary.elb.us-east-1.amazonaws.com"
    zone_id                = "Z35SXDOTRQ7X7K"
    evaluate_target_health = true
  }
}

# ─── Azure Resource Group ────────────────────────────────────────────────────
resource "azurerm_resource_group" "aegis_eastus" {
  name     = "aegis-production-eastus"
  location = "East US"
  tags     = { Project = "aegis-global", Environment = var.environment }
}

# ─── AKS Cluster (Azure — eastus) ────────────────────────────────────────────
resource "azurerm_kubernetes_cluster" "eastus" {
  name                = "aegis-aks-eastus"
  location            = azurerm_resource_group.aegis_eastus.location
  resource_group_name = azurerm_resource_group.aegis_eastus.name
  dns_prefix          = "aegis-eastus"
  kubernetes_version  = var.cluster_version

  default_node_pool {
    name                = "system"
    node_count          = 3
    vm_size             = "Standard_D4s_v5"
    enable_auto_scaling = true
    min_count           = 3
    max_count           = 30
    os_disk_size_gb     = 100
    zones               = ["1", "2", "3"]
  }

  identity { type = "SystemAssigned" }

  network_profile {
    network_plugin     = "azure"
    network_policy     = "calico"
    load_balancer_sku  = "standard"
  }

  oms_agent {
    log_analytics_workspace_id = azurerm_log_analytics_workspace.aegis.id
  }

  tags = { Name = "aegis-aks-eastus" }
}

resource "azurerm_log_analytics_workspace" "aegis" {
  name                = "aegis-log-analytics"
  location            = azurerm_resource_group.aegis_eastus.location
  resource_group_name = azurerm_resource_group.aegis_eastus.name
  sku                 = "PerGB2018"
  retention_in_days   = 90
}

# ─── GKE Cluster (GCP — us-central1) ─────────────────────────────────────────
resource "google_container_cluster" "us_central" {
  name     = "aegis-gke-us-central1"
  location = "us-central1"

  remove_default_node_pool = true
  initial_node_count       = 1

  network_policy {
    enabled  = true
    provider = "CALICO"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  addons_config {
    http_load_balancing        { disabled = false }
    horizontal_pod_autoscaling { disabled = false }
  }
}

resource "google_container_node_pool" "us_central_nodes" {
  name       = "aegis-node-pool"
  location   = "us-central1"
  cluster    = google_container_cluster.us_central.name
  node_count = 3

  autoscaling {
    min_node_count = 3
    max_node_count = 30
  }

  node_config {
    machine_type    = "n2-standard-8"
    disk_size_gb    = 100
    disk_type       = "pd-ssd"
    service_account = google_service_account.gke_nodes.email

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform"
    ]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

resource "google_service_account" "gke_nodes" {
  account_id   = "aegis-gke-nodes"
  display_name = "AEGIS GKE Node Service Account"
}

# ─── BigQuery (Analytics) ────────────────────────────────────────────────────
resource "google_bigquery_dataset" "aegis" {
  dataset_id                  = "aegis_analytics"
  friendly_name               = "AEGIS Global Analytics"
  description                 = "Historical disaster analytics and operational metrics"
  location                    = "US"
  default_table_expiration_ms = null

  access {
    role          = "OWNER"
    special_group = "projectOwners"
  }
}

resource "google_bigquery_table" "disaster_events" {
  dataset_id = google_bigquery_dataset.aegis.dataset_id
  table_id   = "disaster_events"
  deletion_protection = false

  schema = jsonencode([
    { name = "id",             type = "STRING",    mode = "REQUIRED" },
    { name = "name",           type = "STRING",    mode = "REQUIRED" },
    { name = "type",           type = "STRING",    mode = "REQUIRED" },
    { name = "severity",       type = "STRING",    mode = "NULLABLE" },
    { name = "country",        type = "STRING",    mode = "NULLABLE" },
    { name = "deaths",         type = "INTEGER",   mode = "NULLABLE" },
    { name = "affected",       type = "INTEGER",   mode = "NULLABLE" },
    { name = "economic_loss",  type = "FLOAT64",   mode = "NULLABLE" },
    { name = "started_at",     type = "TIMESTAMP", mode = "NULLABLE" },
    { name = "lat",            type = "FLOAT64",   mode = "NULLABLE" },
    { name = "lng",            type = "FLOAT64",   mode = "NULLABLE" },
  ])

  time_partitioning {
    type  = "MONTH"
    field = "started_at"
  }

  clustering = ["type", "severity", "country"]
}

# ─── Outputs ──────────────────────────────────────────────────────────────────
output "eks_primary_endpoint" {
  value       = module.eks_primary.cluster_endpoint
  description = "EKS primary cluster API endpoint"
  sensitive   = true
}

output "rds_primary_endpoint" {
  value       = aws_rds_cluster.primary.endpoint
  description = "Aurora PostgreSQL writer endpoint"
  sensitive   = true
}

output "redis_primary_endpoint" {
  value       = aws_elasticache_replication_group.primary.primary_endpoint_address
  description = "Redis primary endpoint"
  sensitive   = true
}

output "kafka_bootstrap_brokers" {
  value       = aws_msk_cluster.primary.bootstrap_brokers_tls
  description = "MSK Kafka TLS bootstrap brokers"
  sensitive   = true
}

output "cloudfront_domain" {
  value       = aws_cloudfront_distribution.frontend.domain_name
  description = "CloudFront CDN domain"
}

output "aks_eastus_endpoint" {
  value       = azurerm_kubernetes_cluster.eastus.kube_config[0].host
  description = "AKS East US cluster endpoint"
  sensitive   = true
}

output "gke_us_central_endpoint" {
  value       = google_container_cluster.us_central.endpoint
  description = "GKE US Central cluster endpoint"
  sensitive   = true
}

output "kms_key_arn" {
  value       = aws_kms_key.aegis.arn
  description = "AEGIS master KMS key ARN"
}
