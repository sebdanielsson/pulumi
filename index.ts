import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { remote, types } from "@pulumi/command";
import * as onepassword from "@1password/pulumi-onepassword";
import * as github from "@pulumi/github";
import * as hcloud from "@pulumi/hcloud";
import * as tailscale from "@pulumi/tailscale";
import * as command from "@pulumi/command";

const config = new pulumi.Config();

const vault = onepassword.getVault({
  name: "prod",
});

const tailscaleAuthKey = new tailscale.TailnetKey("tailscale-authkey", {
  description: "Authentik Production Server",
  ephemeral: false,
  recreateIfInvalid: 'always',
  reusable: true,
  preauthorized: true,
  tags: ["tag:server"],
});

const sebastianSshKey = onepassword.getItem({
  title: "Sebastian SSH Key",
  vault: 'prod',
});

const sshKey = new hcloud.SshKey("Sebastian SSH Key", {
  name: "Sebastian SSH Key",
  publicKey: sebastianSshKey.then(sebastianSshKey => sebastianSshKey.publicKey),
});

// Create cloud-init script
const userData = pulumi.interpolate`
#cloud-config

users:
  - name: sebastian
    groups: sudo, docker
    sudo: ["ALL=(ALL) NOPASSWD:ALL"]
    shell: /bin/bash
    ssh_authorized_keys:
      - ${sshKey.publicKey}

packages:
  - python3

package_update: true
package_upgrade: true

runcmd:
  - sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config
  - dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  - dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  - systemctl enable --now docker
  - dnf config-manager --add-repo https://pkgs.tailscale.com/stable/centos/9/tailscale.repo
  - dnf install -y tailscale
  - systemctl enable --now tailscaled
  - tailscale up --authkey ${tailscaleAuthKey.key} --ssh
`

const serverId = new random.RandomId("serverId", {
  byteLength: 2,
});

const authentikServer = serverId.hex.apply(hex => new hcloud.Server(`authentik-prod-${hex}`, {
  name: `authentik-prod-${hex}`,
  image: "fedora-40",
  serverType: "cax11",
  location: "hel1",
  publicNets: [{
    ipv4Enabled: true,
    ipv6Enabled: true,
  }],
  sshKeys: ["Sebastian SSH Key"],
  userData: userData,
  labels: {
    env: "prod",
    app: "authentik",
  },
  rebuildProtection: false,
  deleteProtection: false,
}));

// SSH connection details
const connection: types.input.remote.ConnectionArgs = {
  host: authentikServer.name,
  user: "sebastian",
};

// Copy a config file to our server.
const transferAuthentikConfig = new command.remote.CopyToRemote("transferAuthentikConfig", {
  triggers: [authentikServer],
  connection,
  source: new pulumi.asset.FileArchive("./authentik"),
  remotePath: "/opt/authentik",
});

// Execute a basic command on our server.
const extractAuthentikConfig = new command.remote.Command("extractAuthentikConfig", {
  triggers: [transferAuthentikConfig],
  connection,
  create: "tar -xvf /opt/authentik/authentik.tar.gz -C /opt/authentik",
}, { dependsOn: transferAuthentikConfig });

// Export properties
export const authentikServerId = authentikServer.id;
export const authentikServerName = authentikServer.name;
export const authentikServerIpv4Address = authentikServer.ipv4Address;
export const authentikServerIpv6Address = authentikServer.ipv6Address;
